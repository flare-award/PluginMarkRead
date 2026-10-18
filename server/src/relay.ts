/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
    PROTOCOL_VERSION,
    randomBase64Url,
    SERVER_VERSION,
    type AuthMessage,
    type ErrorMessage,
    type ServerErrorCode,
    type ServerLimits,
    type SignedReceipt,
    validateClientMessage,
    verifyAuth,
    verifyReceipt
} from "./protocol.js";
import { TokenBucket } from "./rateLimit.js";
import type { RelayState } from "./store.js";

const AUTH_TIMEOUT_CLOSE_CODE = 4001;
const PROTOCOL_VIOLATION_CLOSE_CODE = 4002;
const RATE_LIMIT_CLOSE_CODE = 4003;
const SHUTDOWN_CLOSE_CODE = 1012;

const RECEIPT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RECEIPT_MAX_FUTURE_MS = 10 * 60 * 1000;
const RECEIPT_ID_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VIOLATIONS = 25;

interface Session {
    id: string;
    socket: WebSocket;
    remoteAddress: string;
    challenge: string;
    challengeIssuedAt: number;
    authTimer?: NodeJS.Timeout;
    userId?: string;
    publicKey?: string;
    deviceId?: string;
    watched: Set<string>;
    receiptBucket: TokenBucket;
    watchBucket: TokenBucket;
    messageBucket: TokenBucket;
    violations: number;
    lastActivity: number;
    closed: boolean;
}

export interface RelayAddress {
    host: string;
    port: number;
}

/**
 * WebSocket relay.
 *
 * Privacy properties:
 *  - the relay only ever sees Discord user ids, device ids for authentication,
 *    and receipt metadata (channel/message ids, timestamps);
 *  - no message content, no Discord credentials and no IP addresses are stored;
 *  - receipts for offline users are queued only in memory or in the optional
 *    data directory, never forwarded to third parties.
 */
export class RelayServer {
    readonly httpServer: Server;
    private readonly wss: WebSocketServer;
    private readonly sessions = new Set<Session>();
    private readonly byUser = new Map<string, Set<Session>>();
    private readonly watchersOf = new Map<string, Set<Session>>();
    private readonly receiptIds = new Map<string, number>();
    private readonly startedAt = Date.now();
    private heartbeat?: NodeJS.Timeout;
    private dedupeSweep?: NodeJS.Timeout;
    private address?: RelayAddress;
    private stopping = false;

    constructor(
        private readonly config: RelayConfig,
        private readonly logger: Logger,
        private readonly state: RelayState
    ) {
        this.httpServer = createServer((req, res) => this.handleHttp(req, res));
        this.httpServer.on("connection", socket => socket.on("error", () => { /* handled by close */ }));

        this.wss = new WebSocketServer({
            noServer: true,
            clientTracking: false,
            maxPayload: this.config.maxFrameBytes
        });

        this.httpServer.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
        this.httpServer.on("clientError", (_error, socket) => {
            socket.destroy();
        });
    }

    get limits(): ServerLimits {
        return {
            maxFrameBytes: this.config.maxFrameBytes,
            receiptBurst: this.config.receiptBurst,
            receiptsPerMinute: this.config.receiptsPerMinute,
            watchPerMinute: this.config.watchesPerMinute
        };
    }

    get connectionCount(): number {
        return this.sessions.size;
    }

    async start(): Promise<RelayAddress> {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                this.httpServer.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                this.httpServer.off("error", onError);
                resolve();
            };
            this.httpServer.once("error", onError);
            this.httpServer.once("listening", onListening);
            this.httpServer.listen(this.config.port, this.config.host);
        });

        const address = this.httpServer.address();
        if (address == null || typeof address === "string") {
            throw new Error("Could not determine the listening address");
        }
        this.address = { host: this.config.host, port: address.port };

        this.heartbeat = setInterval(() => this.checkHeartbeats(), 30_000);
        this.heartbeat.unref?.();

        this.dedupeSweep = setInterval(() => this.sweepDedupe(), 60_000);
        this.dedupeSweep.unref?.();

        return this.address;
    }

    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;

        if (this.heartbeat) clearInterval(this.heartbeat);
        if (this.dedupeSweep) clearInterval(this.dedupeSweep);

        for (const session of [...this.sessions]) {
            this.sendError(session, "server_shutting_down", "The relay is shutting down.", true);
            this.close(session, SHUTDOWN_CLOSE_CODE, "server shutting down");
        }

        await new Promise<void>(resolve => {
            this.wss.close(() => resolve());
        });

        await new Promise<void>(resolve => {
            this.httpServer.close(() => resolve());
            this.httpServer.closeAllConnections?.();
        });

        await this.state.flush();
        this.state.stop();
    }

    /* ---------------------------------------------------------------------- */
    /* HTTP                                                                   */
    /* ---------------------------------------------------------------------- */

    private handleHttp(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, { Allow: "GET, HEAD" }).end();
            return;
        }

        if (req.url === "/healthz") {
            const body = JSON.stringify({
                ok: true,
                version: SERVER_VERSION,
                protocol: PROTOCOL_VERSION,
                uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
                connections: this.sessions.size,
                registeredUsers: this.state.countUsers(),
                queuedUsers: this.state.countInboxUsers()
            });
            res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store"
            });
            res.end(req.method === "HEAD" ? undefined : body);
            return;
        }

        if (req.url === "/") {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(req.method === "HEAD" ? undefined : "MarkRead relay. Connect over WebSocket; see /healthz.\n");
            return;
        }

        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : "Not found\n");
    }

    /* ---------------------------------------------------------------------- */
    /* Connection setup                                                       */
    /* ---------------------------------------------------------------------- */

    private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        if (this.stopping) {
            rejectUpgrade(socket, 503, "Server is shutting down");
            return;
        }

        if (this.sessions.size >= this.config.maxConnectionsTotal) {
            rejectUpgrade(socket, 503, "Server is at capacity");
            return;
        }

        if (this.config.allowedOrigins.length > 0) {
            const origin = req.headers.origin;
            if (typeof origin !== "string" || !this.config.allowedOrigins.includes(origin)) {
                this.logger.warn("Rejected connection from a disallowed origin");
                rejectUpgrade(socket, 403, "Origin not allowed");
                return;
            }
        }

        this.wss.handleUpgrade(req, socket, head, ws => {
            this.onConnection(ws, req);
        });
    }

    private onConnection(socket: WebSocket, req: IncomingMessage): void {
        const session: Session = {
            id: randomUUID(),
            socket,
            remoteAddress: req.socket.remoteAddress ?? "unknown",
            challenge: randomBase64Url(32),
            challengeIssuedAt: Date.now(),
            watched: new Set(),
            receiptBucket: new TokenBucket(this.config.receiptBurst, this.config.receiptsPerMinute / 60_000),
            watchBucket: new TokenBucket(this.config.watchBurst, this.config.watchesPerMinute / 60_000),
            messageBucket: new TokenBucket(40, 20 / 1000),
            violations: 0,
            lastActivity: Date.now(),
            closed: false
        };

        this.sessions.add(session);
        this.logger.debug("Connection opened", { session: session.id, connections: this.sessions.size });

        session.authTimer = setTimeout(() => {
            if (session.userId || session.closed) return;
            this.sendError(session, "auth_timeout", "Authentication was not completed in time.", true);
            this.close(session, AUTH_TIMEOUT_CLOSE_CODE, "auth timeout");
        }, this.config.authTimeoutMs);
        session.authTimer.unref?.();

        socket.on("message", (data, isBinary) => {
            session.lastActivity = Date.now();
            void this.onMessage(session, data, isBinary);
        });

        socket.on("pong", () => {
            session.lastActivity = Date.now();
        });

        socket.on("close", () => this.onClose(session));
        socket.on("error", error => {
            this.logger.debug("Socket error", { session: session.id, error: (error as Error).message });
        });

        this.send(session, {
            type: "hello",
            v: PROTOCOL_VERSION,
            challenge: session.challenge,
            serverVersion: SERVER_VERSION,
            serverTime: Date.now(),
            limits: this.limits
        });
    }

    private onClose(session: Session): void {
        if (session.closed) {
            this.removeSession(session);
            return;
        }
        session.closed = true;
        this.removeSession(session);
    }

    private removeSession(session: Session): void {
        if (!this.sessions.delete(session)) return;

        if (session.authTimer) clearTimeout(session.authTimer);

        for (const target of session.watched) {
            this.watchersOf.get(target)?.delete(session);
        }
        session.watched.clear();

        const userId = session.userId;
        if (!userId) return;

        const userSessions = this.byUser.get(userId);
        userSessions?.delete(session);
        if (!userSessions || userSessions.size === 0) {
            this.byUser.delete(userId);
            this.broadcastPresence(userId);
        }

        this.logger.debug("Connection closed", { userId, connections: this.sessions.size });
    }

    /* ---------------------------------------------------------------------- */
    /* Incoming frames                                                        */
    /* ---------------------------------------------------------------------- */

    private async onMessage(session: Session, data: unknown, isBinary: boolean): Promise<void> {
        if (session.closed) return;

        if (isBinary) {
            this.violation(session, "Binary frames are not supported.");
            return;
        }

        if (!this.consumeMessageBudget(session)) return;

        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        if (Buffer.byteLength(text, "utf8") > this.config.maxFrameBytes) {
            this.sendError(session, "payload_too_large", "Frame exceeds the maximum size.", true);
            this.close(session, PROTOCOL_VIOLATION_CLOSE_CODE, "frame too large");
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.violation(session, "Malformed JSON.");
            return;
        }

        const message = validateClientMessage(parsed);
        if (!message) {
            this.violation(session, "Message does not match the protocol.");
            return;
        }

        if (!session.userId && message.type !== "auth") {
            this.sendError(session, "not_authenticated", "Authenticate before sending other messages.", true);
            this.close(session, 4004, "not authenticated");
            return;
        }

        switch (message.type) {
            case "auth":
                await this.handleAuth(session, message);
                break;
            case "receipt":
                await this.handleReceipt(session, message.receipt);
                break;
            case "watch":
                this.handleWatch(session, message.userId);
                break;
            case "unwatch":
                this.handleUnwatch(session, message.userId);
                break;
            case "ping":
                this.send(session, { type: "pong", t: message.t, serverTime: Date.now() });
                break;
        }
    }

    private async handleAuth(session: Session, auth: AuthMessage): Promise<void> {
        if (session.userId) {
            this.violation(session, "Already authenticated.");
            return;
        }

        if (auth.nonce !== session.challenge) {
            this.failAuth(session, "auth_failed", "The challenge does not match.");
            return;
        }

        if (Date.now() - session.challengeIssuedAt > this.config.authTimeoutMs) {
            this.failAuth(session, "auth_timeout", "The challenge expired.");
            return;
        }

        // A challenge is single use, even when authentication fails.
        session.challenge = randomBase64Url(32);
        session.challengeIssuedAt = Date.now();

        if (!(await verifyAuth(auth))) {
            this.failAuth(session, "auth_failed", "The authentication signature is invalid.");
            return;
        }

        if (session.closed) return;

        const existing = this.state.getEntry(auth.userId);
        if (existing && existing.publicKey !== auth.publicKey) {
            this.failAuth(session, "key_mismatch", "Another key is already registered for this account.");
            return;
        }

        const userSessions = this.byUser.get(auth.userId);
        if (userSessions && userSessions.size >= this.config.maxConnectionsPerUser) {
            this.failAuth(session, "too_many_connections", "Too many active connections for this account.");
            return;
        }

        const now = Date.now();
        const result = await this.state.register(auth.userId, auth.publicKey, now);
        if (result === "mismatch") {
            this.failAuth(session, "key_mismatch", "Another key is already registered for this account.");
            return;
        }

        if (session.closed) return;

        if (session.authTimer) {
            clearTimeout(session.authTimer);
            session.authTimer = undefined;
        }

        session.userId = auth.userId;
        session.publicKey = auth.publicKey;
        session.deviceId = auth.deviceId;

        const sessions = this.byUser.get(auth.userId) ?? new Set<Session>();
        sessions.add(session);
        this.byUser.set(auth.userId, sessions);

        const pending = this.state.takeQueued(auth.userId, now);
        this.send(session, {
            type: "ready",
            userId: auth.userId,
            sessionId: session.id,
            serverTime: now,
            pendingReceipts: pending.length
        });

        for (const item of pending) {
            this.sendReceipt(session, item.receipt, item.receivedAt);
        }

        this.broadcastPresence(auth.userId);
        this.logger.info("User connected", {
            userId: auth.userId,
            deviceId: auth.deviceId,
            clientVersion: auth.clientVersion,
            sessions: sessions.size
        });
    }

    private async handleReceipt(session: Session, receipt: SignedReceipt): Promise<void> {
        const userId = session.userId;
        if (!userId || !session.publicKey) return;

        const budget = session.receiptBucket.tryConsume();
        if (!budget.ok) {
            this.sendError(session, "rate_limited", "Too many receipts.", false, budget.retryAfterMs);
            if (++session.violations > MAX_VIOLATIONS) {
                this.close(session, RATE_LIMIT_CLOSE_CODE, "rate limit abuse");
            }
            return;
        }

        if (receipt.payload.from !== userId || receipt.publicKey !== session.publicKey) {
            this.rejectReceipt(session, "The receipt does not belong to the authenticated user.");
            return;
        }

        const now = Date.now();
        const payload = receipt.payload;

        if (payload.sentAt > now + RECEIPT_MAX_FUTURE_MS || payload.sentAt < now - RECEIPT_MAX_AGE_MS) {
            this.rejectReceipt(session, "The receipt timestamp is outside the accepted window.");
            return;
        }

        if (payload.readAt > payload.sentAt + 60_000 || payload.readAt < payload.sentAt - 60_000) {
            this.rejectReceipt(session, "The receipt read time is inconsistent.");
            return;
        }

        if (this.receiptIds.has(payload.receiptId)) {
            // Duplicate submission: silently ignore, the first copy was delivered.
            this.logger.debug("Dropped duplicate receipt", { userId });
            return;
        }

        if (!(await verifyReceipt(receipt))) {
            this.rejectReceipt(session, "The receipt signature is invalid.");
            return;
        }

        if (session.closed || session.userId !== userId) return;

        this.rememberReceiptId(payload.receiptId, now);

        if (!this.state.hasUser(payload.to)) {
            this.logger.debug("Dropped receipt for an unregistered recipient", { userId });
            return;
        }

        const targets = this.byUser.get(payload.to);
        if (targets && targets.size > 0) {
            for (const target of targets) this.sendReceipt(target, receipt, now);
            this.logger.debug("Forwarded receipt", { from: userId, delivered: targets.size });
            return;
        }

        this.state.enqueue(payload.to, receipt, now);
        this.logger.debug("Queued receipt for an offline recipient", { userId });
    }

    private rejectReceipt(session: Session, message: string): void {
        this.sendError(session, "invalid_receipt", message, false);
        if (++session.violations > MAX_VIOLATIONS) {
            this.close(session, PROTOCOL_VIOLATION_CLOSE_CODE, "too many invalid receipts");
        }
    }

    private handleWatch(session: Session, target: string): void {
        if (session.closed) return;

        const budget = session.watchBucket.tryConsume();
        if (!budget.ok) {
            this.sendError(session, "rate_limited", "Too many watch requests.", false, budget.retryAfterMs);
            return;
        }

        session.watched.add(target);

        const watchers = this.watchersOf.get(target) ?? new Set<Session>();
        watchers.add(session);
        this.watchersOf.set(target, watchers);

        this.send(session, this.peerMessage(target));
    }

    private handleUnwatch(session: Session, target: string): void {
        session.watched.delete(target);
        this.watchersOf.get(target)?.delete(session);
    }

    /* ---------------------------------------------------------------------- */
    /* Helpers                                                                */
    /* ---------------------------------------------------------------------- */

    private peerMessage(target: string) {
        const entry = this.state.getEntry(target);
        const online = (this.byUser.get(target)?.size ?? 0) > 0;
        return {
            type: "peer" as const,
            userId: target,
            registered: entry != null,
            online,
            ...(entry ? { keyFingerprint: entry.fingerprint } : {}),
            watchedAt: Date.now()
        };
    }

    private broadcastPresence(userId: string): void {
        const watchers = this.watchersOf.get(userId);
        if (!watchers || watchers.size === 0) return;

        const message = this.peerMessage(userId);
        for (const watcher of watchers) {
            if (watcher.closed || watcher.userId === userId) continue;
            this.send(watcher, message);
        }
    }

    private sendReceipt(session: Session, receipt: SignedReceipt, receivedAt: number): void {
        this.send(session, { type: "receipt", receipt, receivedAt });
    }

    private consumeMessageBudget(session: Session): boolean {
        const budget = session.messageBucket.tryConsume();
        if (budget.ok) return true;

        this.sendError(session, "rate_limited", "Too many messages.", false, budget.retryAfterMs);
        if (++session.violations > MAX_VIOLATIONS) {
            this.close(session, RATE_LIMIT_CLOSE_CODE, "message rate limit");
        }
        return false;
    }

    private violation(session: Session, message: string): void {
        this.sendError(session, "bad_message", message, false);
        if (++session.violations > MAX_VIOLATIONS) {
            this.close(session, PROTOCOL_VIOLATION_CLOSE_CODE, "too many protocol violations");
        }
    }

    private failAuth(session: Session, code: ServerErrorCode, message: string): void {
        this.sendError(session, code, message, true);
        this.close(session, PROTOCOL_VIOLATION_CLOSE_CODE, code);
    }

    private rememberReceiptId(receiptId: string, now: number): void {
        this.receiptIds.set(receiptId, now + RECEIPT_ID_TTL_MS);
        if (this.receiptIds.size > 200_000) this.sweepDedupe();
    }

    private sweepDedupe(now = Date.now()): void {
        for (const [receiptId, expiresAt] of this.receiptIds) {
            if (expiresAt <= now) this.receiptIds.delete(receiptId);
        }
    }

    private checkHeartbeats(): void {
        const now = Date.now();
        for (const session of this.sessions) {
            if (now - session.lastActivity > this.config.idleTimeoutMs) {
                this.close(session, 4005, "idle timeout");
                continue;
            }
            try {
                session.socket.ping();
            } catch {
                this.close(session, 4006, "ping failed");
            }
        }
    }

    private send(session: Session, message: unknown): void {
        if (session.closed) return;
        if (session.socket.readyState !== WebSocket.OPEN) return;
        try {
            session.socket.send(JSON.stringify(message));
        } catch (error) {
            this.logger.debug("Could not send frame", { error: (error as Error).message });
            this.close(session, 4007, "send failed");
        }
    }

    private sendError(
        session: Session,
        code: ServerErrorCode,
        message: string,
        fatal: boolean,
        retryAfterMs?: number
    ): void {
        const payload: ErrorMessage = {
            type: "error",
            code,
            message,
            fatal,
            ...(retryAfterMs != null ? { retryAfterMs } : {})
        };
        this.send(session, payload);
    }

    private close(session: Session, code: number, reason: string): void {
        if (session.closed) return;
        session.closed = true;

        if (session.authTimer) clearTimeout(session.authTimer);

        try {
            session.socket.close(code, reason.slice(0, 120));
        } catch {
            // The socket is already gone.
        }

        const timer = setTimeout(() => {
            try {
                session.socket.terminate();
            } catch {
                // ignore
            }
        }, 1_000);
        timer.unref?.();

        this.removeSession(session);
    }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    const body = `${message}\n`;
    socket.write(
        `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Service Unavailable"}\r\n`
        + "Connection: close\r\n"
        + "Content-Type: text/plain; charset=utf-8\r\n"
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + "\r\n"
        + body
    );
    socket.destroy();
}

