/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    computeBackoffMs,
    normalizeServerUrl,
    PROTOCOL_VERSION,
    type ServerMessage,
    signAuth,
    type SignedReceipt,
    validateServerMessage,
    verifyReceipt } from "../protocol";
import {
    type ConnectionPhase,
    ConnectionStateStore,
    type PeerStatus,
    PeerStatusStore
} from "./stores";

export interface SigningIdentity {
    privateKey: CryptoKey;
    publicKey: string;
}

export interface ConnectionConfig {
    enabled: boolean;
    serverUrl: string;
}

export interface ConnectionLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export interface ConnectionOptions {
    userId: string;
    config: ConnectionConfig;
    statusStore: ConnectionStateStore;
    peerStore: PeerStatusStore;
    getIdentity(): Promise<SigningIdentity>;
    getDeviceId(): Promise<string>;
    onReceipt(receipt: SignedReceipt, receivedAt: number): void | Promise<void>;
    logger: ConnectionLogger;
    /** Injectable for tests; defaults to the renderer WebSocket. */
    socketFactory?(url: string): WebSocket;
    now?(): number;
}

interface QueuedReceipt {
    receipt: SignedReceipt;
    queuedAt: number;
}

const AUTH_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const OUTBOX_MAX = 100;
const OUTBOX_TTL_MS = 60 * 60 * 1000;
const WATCH_COOLDOWN_MS = 5_000;

/**
 * WebSocket client for the MarkRead relay.
 *
 * The connection owns its socket, timers and a bounded outbox. It never
 * reconnects after a fatal protocol error (wrong key, unsupported version,
 * authentication failure) because repeating the same handshake cannot help.
 */
export class MarkReadConnection {
    private readonly statusStore: ConnectionStateStore;
    private readonly peerStore: PeerStatusStore;
    private readonly logger: ConnectionLogger;
    private readonly now: () => number;
    private readonly socketFactory: (url: string) => WebSocket;

    private config: ConnectionConfig;
    private normalizedUrl?: string;
    private socket?: WebSocket;
    private phase: ConnectionPhase = "disabled";
    private stopped = true;
    private attempt = 0;

    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private authTimer?: ReturnType<typeof setTimeout>;
    private pingTimer?: ReturnType<typeof setInterval>;

    private challenge?: string;
    private lastPongAt = 0;
    private outbox: QueuedReceipt[] = [];
    private readonly watched = new Set<string>();
    private readonly lastWatchAt = new Map<string, number>();

    constructor(private readonly options: ConnectionOptions) {
        this.statusStore = options.statusStore;
        this.peerStore = options.peerStore;
        this.logger = options.logger;
        this.now = options.now ?? (() => Date.now());
        this.socketFactory = options.socketFactory ?? (url => new WebSocket(url));
        this.config = options.config;
    }

    /* ---------------------------------------------------------------------- */
    /* Public API                                                             */
    /* ---------------------------------------------------------------------- */

    getPhase(): ConnectionPhase {
        return this.phase;
    }

    getServerUrl(): string | undefined {
        return this.normalizedUrl;
    }

    /** Applies new settings; reconnects only when the transport changed. */
    configure(config: ConnectionConfig): void {
        const previous = this.config;
        this.config = config;

        if (!config.enabled) {
            this.shutdown("disabled");
            return;
        }

        const normalized = normalizeServerUrl(config.serverUrl);
        if (normalized.error) {
            this.normalizedUrl = undefined;
            this.shutdown(normalized.error === "not_configured" ? "not_configured" : "error", normalized.error);
            return;
        }

        if (
            !this.stopped
            && this.normalizedUrl === normalized.url
            && (this.phase === "online" || this.phase === "connecting" || this.phase === "authenticating")
        ) {
            return;
        }

        this.normalizedUrl = normalized.url;
        this.restart();
    }

    start(): void {
        this.stopped = false;
        this.configure(this.config);
    }

    stop(): void {
        this.shutdown("disabled");
    }

    reconnectNow(): void {
        if (!this.config.enabled) return;
        this.stopped = false;
        this.restart();
    }

    /**
     * Signs nothing: the caller passes an already signed receipt. Returns false
     * when the receipt could not even be queued (connection disabled).
     */
    sendReceipt(receipt: SignedReceipt): boolean {
        if (!this.config.enabled || this.stopped) return false;

        if (this.canSendNow()) {
            if (this.send({ type: "receipt", receipt })) return true;
        }

        const now = this.now();
        this.outbox.push({ receipt, queuedAt: now });
        while (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
        return true;
    }

    watchPeer(userId: string): void {
        this.watched.add(userId);

        if (!this.canSendNow()) return;

        const now = this.now();
        const last = this.lastWatchAt.get(userId) ?? 0;
        if (now - last < WATCH_COOLDOWN_MS) return;

        this.lastWatchAt.set(userId, now);
        this.send({ type: "watch", userId });
    }

    unwatchPeer(userId: string): void {
        if (!this.watched.delete(userId)) return;
        if (this.canSendNow()) this.send({ type: "unwatch", userId });
    }

    /* ---------------------------------------------------------------------- */
    /* Socket lifecycle                                                       */
    /* ---------------------------------------------------------------------- */

    private restart(): void {
        this.clearTimers();
        this.closeSocket(1000, "restart");
        this.attempt = 0;
        this.outbox = [];
        this.watched.clear();
        this.lastWatchAt.clear();
        this.open();
    }

    private shutdown(phase: "disabled" | "not_configured" | "error", error?: string): void {
        this.stopped = true;
        this.phase = phase;
        this.clearTimers();
        this.closeSocket(1000, "shutdown");
        this.outbox = [];
        this.watched.clear();
        this.lastWatchAt.clear();
        this.challenge = undefined;

        this.statusStore.set({
            phase,
            url: this.normalizedUrl,
            error,
            since: this.now()
        });
    }

    private open(): void {
        if (this.stopped) return;

        if (!this.normalizedUrl) {
            const normalized = normalizeServerUrl(this.config.serverUrl);
            if (normalized.error) {
                this.shutdown(normalized.error === "not_configured" ? "not_configured" : "error", normalized.error);
                return;
            }
            this.normalizedUrl = normalized.url;
        }

        const { normalizedUrl: url } = this;
        if (!url) return;
        this.phase = this.attempt > 0 ? "reconnecting" : "connecting";
        this.statusStore.set({
            phase: this.phase,
            url,
            since: this.now()
        });

        let socket: WebSocket;
        try {
            socket = this.socketFactory(url);
        } catch (error) {
            this.logger.warn("Could not create the WebSocket", error);
            this.scheduleReconnect("connection_failed");
            return;
        }

        this.socket = socket;

        socket.onopen = () => {
            if (this.socket !== socket) return;

            this.phase = "authenticating";
            this.statusStore.set({ phase: "authenticating", url, since: this.now() });

            this.authTimer = setTimeout(() => {
                if (this.socket !== socket || this.phase !== "authenticating") return;
                this.logger.warn("Authentication timed out");
                this.closeSocket(4001, "auth timeout");
                this.scheduleReconnect("auth_timeout");
            }, AUTH_TIMEOUT_MS);
        };

        socket.onmessage = event => {
            if (this.socket !== socket) return;
            void this.handleRaw(event.data);
        };

        socket.onerror = () => {
            this.logger.debug("WebSocket error");
        };

        socket.onclose = event => {
            if (this.socket !== socket) return;

            this.socket = undefined;
            this.challenge = undefined;
            this.clearSocketTimers();

            if (this.stopped || this.phase === "error") return;

            this.logger.info("Connection closed", event.code);
            this.scheduleReconnect(event.code === 1000 ? "connection_closed" : `connection_closed_${event.code}`);
        };
    }

    private scheduleReconnect(error: string): void {
        if (this.stopped) return;

        this.phase = "reconnecting";
        this.attempt++;

        const delay = computeBackoffMs(this.attempt - 1);
        const retryAt = this.now() + delay;

        this.statusStore.set({
            phase: "reconnecting",
            url: this.normalizedUrl,
            error,
            since: this.now(),
            nextRetryAt: retryAt
        });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.open();
        }, delay);
    }

    private failFatal(code: string): void {
        this.phase = "error";
        this.stopped = true;
        this.clearTimers();
        this.closeSocket(4000, code);

        this.statusStore.set({
            phase: "error",
            url: this.normalizedUrl,
            error: code,
            since: this.now()
        });
    }

    /* ---------------------------------------------------------------------- */
    /* Frames                                                                 */
    /* ---------------------------------------------------------------------- */

    private async handleRaw(data: unknown): Promise<void> {
        if (typeof data !== "string") {
            this.logger.warn("Ignoring a non-text WebSocket frame");
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            this.logger.warn("Ignoring malformed JSON from the relay");
            return;
        }

        const message = validateServerMessage(parsed);
        if (!message) {
            this.logger.warn("Ignoring an invalid relay message");
            return;
        }

        await this.handleMessage(message);
    }

    private async handleMessage(message: ServerMessage): Promise<void> {
        switch (message.type) {
            case "hello":
                await this.handleHello(message);
                return;
            case "ready":
                this.handleReady();
                return;
            case "error":
                this.handleServerError(message.code, message.message, message.fatal);
                return;
            case "peer":
                this.handlePeer(message);
                return;
            case "receipt":
                await this.handleIncomingReceipt(message.receipt, message.receivedAt);
                return;
            case "pong":
                this.lastPongAt = this.now();
                return;
        }
    }

    private async handleHello(message: Extract<ServerMessage, { type: "hello"; }>): Promise<void> {
        if (message.v !== PROTOCOL_VERSION) {
            this.failFatal("unsupported_protocol");
            return;
        }

        if (this.phase !== "authenticating") return;
        this.challenge = message.challenge;

        let identity: SigningIdentity;
        try {
            identity = await this.options.getIdentity();
        } catch (error) {
            this.logger.error("Could not load the local identity", error);
            this.failFatal("identity_unavailable");
            return;
        }

        if (this.stopped || this.challenge !== message.challenge || this.socket?.readyState !== WebSocket.OPEN) return;

        try {
            const auth = await signAuth(identity.privateKey, {
                userId: this.options.userId,
                deviceId: await this.options.getDeviceId(),
                nonce: message.challenge,
                publicKey: identity.publicKey
            });

            if (this.socket?.readyState !== WebSocket.OPEN) return;
            this.send(auth);
        } catch (error) {
            this.logger.error("Could not sign the authentication challenge", error);
            this.failFatal("identity_unavailable");
        }
    }

    private handleReady(): void {
        this.phase = "online";
        this.attempt = 0;
        this.lastPongAt = this.now();
        this.clearSocketTimers();
        this.startPing();

        this.statusStore.set({
            phase: "online",
            url: this.normalizedUrl,
            since: this.now()
        });

        const now = this.now();
        const pending = this.outbox;
        this.outbox = [];
        for (const item of pending) {
            if (now - item.queuedAt > OUTBOX_TTL_MS) continue;
            this.send({ type: "receipt", receipt: item.receipt });
        }

        for (const userId of this.watched) {
            this.lastWatchAt.set(userId, now);
            this.send({ type: "watch", userId });
        }

        this.logger.info("Connected to the relay");
    }

    private handleServerError(code: string, description: string, fatal: boolean): void {
        this.logger.warn("Relay error", code, description);

        if (fatal) {
            this.failFatal(code);
            return;
        }

        // Non-fatal errors (rate limits, a rejected receipt) keep the
        // connection online; the next periodic message retries naturally.
        this.statusStore.set({
            phase: this.phase === "online" ? "online" : this.phase,
            url: this.normalizedUrl,
            error: code,
            since: this.now()
        });
    }

    private handlePeer(message: Extract<ServerMessage, { type: "peer"; }>): void {
        const status: PeerStatus = {
            userId: message.userId,
            registered: message.registered,
            online: message.online,
            keyFingerprint: message.keyFingerprint,
            watchedAt: message.watchedAt,
            receivedAt: this.now()
        };
        this.peerStore.set(status);
    }

    private async handleIncomingReceipt(receipt: SignedReceipt, receivedAt: number): Promise<void> {
        if (receipt.payload.to !== this.options.userId) {
            this.logger.warn("Ignoring a receipt addressed to another user");
            return;
        }

        if (!(await verifyReceipt(receipt))) {
            this.logger.warn("Ignoring a receipt with an invalid signature");
            return;
        }

        try {
            await this.options.onReceipt(receipt, receivedAt);
        } catch (error) {
            this.logger.error("Could not apply an incoming receipt", error);
        }
    }

    /* ---------------------------------------------------------------------- */
    /* Utilities                                                              */
    /* ---------------------------------------------------------------------- */

    private canSendNow(): boolean {
        return !this.stopped && this.phase === "online" && this.socket?.readyState === WebSocket.OPEN;
    }

    private send(message: unknown): boolean {
        const { socket } = this;
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;

        try {
            socket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            this.logger.warn("Could not send a frame", error);
            return false;
        }
    }

    private startPing(): void {
        this.pingTimer = setInterval(() => {
            if (this.phase !== "online" || this.socket?.readyState !== WebSocket.OPEN) return;

            if (this.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
                this.logger.warn("Relay did not answer pings, reconnecting");
                this.closeSocket(4002, "pong timeout");
                this.scheduleReconnect("pong_timeout");
                return;
            }

            this.send({ type: "ping", t: this.now() });
        }, PING_INTERVAL_MS);
    }

    private clearSocketTimers(): void {
        if (this.authTimer != null) {
            clearTimeout(this.authTimer);
            this.authTimer = undefined;
        }
        if (this.pingTimer != null) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
    }

    private clearTimers(): void {
        this.clearSocketTimers();
        if (this.reconnectTimer != null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private closeSocket(code: number, reason: string): void {
        this.clearSocketTimers();

        const { socket } = this;
        this.socket = undefined;

        if (!socket) return;

        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;

        try {
            socket.close(code, reason.slice(0, 120));
        } catch {
            // Already closed.
        }
    }
}
