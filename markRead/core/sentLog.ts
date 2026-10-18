/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isSnowflake, LIMITS } from "../protocol";

export interface SentLogEntry {
    channelId: string;
    messageVersion: number;
    sentAt: number;
}

export interface SerializedSentLog {
    v: 1;
    entries: Record<string, SentLogEntry>;
}

/**
 * Remembers which versions of which messages this client already confirmed.
 *
 * This is the last line of defence against duplicate receipts: re-renders,
 * scrolling, channel switches, a second Discord window and plugin restarts all
 * end up here before a signature is created.
 */
export class SentLog {
    private readonly entries = new Map<string, SentLogEntry>();
    private readonly listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    get size(): number {
        return this.entries.size;
    }

    has(messageId: string, messageVersion: number): boolean {
        return this.entries.get(messageId)?.messageVersion === messageVersion;
    }

    get(messageId: string): SentLogEntry | undefined {
        return this.entries.get(messageId);
    }

    mark(messageId: string, entry: SentLogEntry): void {
        const existing = this.entries.get(messageId);
        if (existing && existing.messageVersion >= entry.messageVersion) return;

        this.entries.set(messageId, entry);

        if (this.entries.size > LIMITS.maxSentLog) {
            const excess = this.entries.size - LIMITS.maxSentLog;
            let removed = 0;
            for (const key of this.entries.keys()) {
                this.entries.delete(key);
                if (++removed >= excess) break;
            }
        }

        this.emit();
    }

    removeMessages(messageIds: Iterable<string>): boolean {
        let changed = false;
        for (const messageId of messageIds) {
            changed = this.entries.delete(messageId) || changed;
        }
        if (changed) this.emit();
        return changed;
    }

    clear(): void {
        if (this.entries.size === 0) return;
        this.entries.clear();
        this.emit();
    }

    prune(now: number = Date.now(), maxEntries: number = LIMITS.maxSentLog, ttlMs: number = LIMITS.sentLogTtlMs): boolean {
        let changed = false;

        for (const [messageId, entry] of this.entries) {
            if (now - entry.sentAt > ttlMs) {
                this.entries.delete(messageId);
                changed = true;
            }
        }

        if (this.entries.size > maxEntries) {
            const excess = this.entries.size - maxEntries;
            let removed = 0;
            for (const key of this.entries.keys()) {
                this.entries.delete(key);
                if (++removed >= excess) break;
            }
            changed = true;
        }

        if (changed) this.emit();
        return changed;
    }

    serialize(): SerializedSentLog {
        return { v: 1, entries: Object.fromEntries(this.entries) };
    }

    deserialize(value: unknown): void {
        this.entries.clear();

        if (typeof value === "object" && value !== null) {
            const data = value as Record<string, unknown>;
            if (data.v === 1 && typeof data.entries === "object" && data.entries !== null) {
                for (const [messageId, entry] of Object.entries(data.entries as Record<string, unknown>)) {
                    if (!isSnowflake(messageId) || !isSentLogEntry(entry)) continue;
                    this.entries.set(messageId, entry);
                }
            }
        }

        this.emit();
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // Listeners must never break the store.
            }
        }
    }
}

function isSentLogEntry(value: unknown): value is SentLogEntry {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return isSnowflake(entry.channelId)
        && isNonNegativeSafeInt(entry.messageVersion)
        && isNonNegativeSafeInt(entry.sentAt);
}

function isNonNegativeSafeInt(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
