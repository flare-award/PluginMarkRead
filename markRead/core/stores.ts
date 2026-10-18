/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isSnowflake, LIMITS } from "../protocol";

type Listener = () => void;

export abstract class Observable {
    private readonly listeners = new Set<Listener>();

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    protected emit(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // A throwing subscriber must not affect the other subscribers.
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Per-channel opt-out                                                         */
/* -------------------------------------------------------------------------- */

export class OptOutStore extends Observable {
    private readonly channelIds = new Set<string>();

    has(channelId: string): boolean {
        return this.channelIds.has(channelId);
    }

    list(): string[] {
        return [...this.channelIds];
    }

    add(channelId: string): void {
        if (!isSnowflake(channelId) || this.channelIds.has(channelId)) return;

        this.channelIds.add(channelId);
        if (this.channelIds.size > LIMITS.maxOptOutChannels) {
            const oldest = this.channelIds.values().next().value;
            if (oldest != null) this.channelIds.delete(oldest);
        }
        this.emit();
    }

    remove(channelId: string): boolean {
        const removed = this.channelIds.delete(channelId);
        if (removed) this.emit();
        return removed;
    }

    /** @returns true when confirmations are now disabled for this channel. */
    toggle(channelId: string): boolean {
        if (this.channelIds.has(channelId)) {
            this.remove(channelId);
            return false;
        }

        this.add(channelId);
        return this.has(channelId);
    }

    clear(): void {
        if (this.channelIds.size === 0) return;
        this.channelIds.clear();
        this.emit();
    }

    serialize(): { v: 1; channels: string[]; } {
        return { v: 1, channels: [...this.channelIds] };
    }

    deserialize(value: unknown): void {
        this.channelIds.clear();

        if (typeof value === "object" && value !== null) {
            const data = value as Record<string, unknown>;
            if (data.v === 1 && Array.isArray(data.channels)) {
                for (const channelId of data.channels) {
                    if (isSnowflake(channelId)) this.channelIds.add(channelId);
                }
            }
        }

        this.emit();
    }
}

/* -------------------------------------------------------------------------- */
/* Pinned peer keys (trust on first use)                                       */
/* -------------------------------------------------------------------------- */

export interface PinnedPeer {
    userId: string;
    publicKey: string;
    pinnedAt: number;
}

export type PinResult = "new" | "same" | "mismatch";

export class PinnedPeerStore extends Observable {
    private readonly peers = new Map<string, PinnedPeer>();

    pin(userId: string, publicKey: string, now = Date.now()): PinResult {
        if (!isSnowflake(userId) || typeof publicKey !== "string") return "mismatch";

        const existing = this.peers.get(userId);
        if (existing) {
            return existing.publicKey === publicKey ? "same" : "mismatch";
        }

        this.peers.set(userId, { userId, publicKey, pinnedAt: now });
        if (this.peers.size > LIMITS.maxPinnedPeers) {
            const oldest = this.peers.keys().next().value;
            if (oldest != null) this.peers.delete(oldest);
        }
        this.emit();
        return "new";
    }

    get(userId: string): PinnedPeer | undefined {
        return this.peers.get(userId);
    }

    forget(userId: string): boolean {
        const removed = this.peers.delete(userId);
        if (removed) this.emit();
        return removed;
    }

    list(): PinnedPeer[] {
        return [...this.peers.values()];
    }

    clear(): void {
        if (this.peers.size === 0) return;
        this.peers.clear();
        this.emit();
    }

    serialize(): { v: 1; peers: Record<string, { publicKey: string; pinnedAt: number; }>; } {
        return {
            v: 1,
            peers: Object.fromEntries(
                [...this.peers].map(([userId, peer]) => [userId, { publicKey: peer.publicKey, pinnedAt: peer.pinnedAt }])
            )
        };
    }

    deserialize(value: unknown): void {
        this.peers.clear();

        if (typeof value === "object" && value !== null) {
            const data = value as Record<string, unknown>;
            if (data.v === 1 && typeof data.peers === "object" && data.peers !== null) {
                for (const [userId, raw] of Object.entries(data.peers as Record<string, unknown>)) {
                    if (!isSnowflake(userId) || typeof raw !== "object" || raw === null) continue;
                    const entry = raw as Record<string, unknown>;
                    if (typeof entry.publicKey !== "string") continue;
                    const pinnedAt = typeof entry.pinnedAt === "number" && Number.isSafeInteger(entry.pinnedAt)
                        ? entry.pinnedAt
                        : 0;
                    this.peers.set(userId, { userId, publicKey: entry.publicKey, pinnedAt });
                }
            }
        }

        this.emit();
    }
}

/* -------------------------------------------------------------------------- */
/* Peer availability                                                           */
/* -------------------------------------------------------------------------- */

export interface PeerStatus {
    userId: string;
    registered: boolean;
    online: boolean;
    keyFingerprint?: string;
    watchedAt: number;
    receivedAt: number;
    error?: string;
}

export class PeerStatusStore extends Observable {
    private readonly peers = new Map<string, PeerStatus>();

    get(userId: string): PeerStatus | undefined {
        return this.peers.get(userId);
    }

    set(status: PeerStatus): void {
        this.peers.set(status.userId, status);

        if (this.peers.size > LIMITS.maxPinnedPeers) {
            const oldest = this.peers.keys().next().value;
            if (oldest != null) this.peers.delete(oldest);
        }

        this.emit();
    }

    setError(userId: string, error: string): void {
        this.set({
            userId,
            registered: false,
            online: false,
            watchedAt: Date.now(),
            receivedAt: Date.now(),
            error
        });
    }

    clear(): void {
        if (this.peers.size === 0) return;
        this.peers.clear();
        this.emit();
    }
}

/* -------------------------------------------------------------------------- */
/* Connection state                                                            */
/* -------------------------------------------------------------------------- */

export type ConnectionPhase =
    | "disabled"
    | "not_configured"
    | "connecting"
    | "authenticating"
    | "online"
    | "reconnecting"
    | "error";

export interface ConnectionState {
    phase: ConnectionPhase;
    url?: string;
    error?: string;
    since: number;
    nextRetryAt?: number;
}

export class ConnectionStateStore extends Observable {
    private state: ConnectionState = { phase: "disabled", since: Date.now() };

    get(): ConnectionState {
        return this.state;
    }

    set(state: ConnectionState): void {
        this.state = state;
        this.emit();
    }

    isOnline(): boolean {
        return this.state.phase === "online";
    }

    clear(): void {
        this.set({ phase: "disabled", since: Date.now() });
    }
}
