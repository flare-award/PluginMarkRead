/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    isSnowflake,
    isUuid,
    LIMITS,
    type ReceiptPayload
} from "../protocol";

/** A verified read confirmation, persisted locally. */
export interface ReceiptRecord {
    receiptId: string;
    /** Discord id of the peer that read the message. */
    from: string;
    /** Discord id of the message author (the local user). */
    to: string;
    channelId: string;
    messageId: string;
    /** Edited timestamp of the message at the time it was read; 0 for unedited. */
    messageVersion: number;
    /** Recipient's clock when the message became visible. */
    readAt: number;
    /** Local clock when the relay delivered the confirmation. */
    receivedAt: number;
}

export interface SerializedReceipts {
    v: 1;
    receipts: ReceiptRecord[];
}

export function receiptRecordFromPayload(payload: ReceiptPayload, receivedAt: number): ReceiptRecord {
    return {
        receiptId: payload.receiptId,
        from: payload.from,
        to: payload.to,
        channelId: payload.channelId,
        messageId: payload.messageId,
        messageVersion: payload.messageVersion,
        readAt: payload.readAt,
        receivedAt
    };
}

export type MessageVersionSource = {
    editedTimestamp?: Date | number | string | null;
};

/**
 * Discord stores `editedTimestamp` as a Date (or a timestamp string after a
 * reconnect / cache restore). Unedited messages have no timestamp, encoded as 0.
 */
export function getMessageVersion(message: MessageVersionSource | null | undefined): number {
    const value = message?.editedTimestamp;
    if (value == null) return 0;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Local store of read confirmations, keyed by message id.
 *
 * Versioning rules:
 *  - only the newest confirmed version of a message is kept;
 *  - an older confirmation is ignored (the UI may still show "read before
 *    edit" for the previous version while the message is edited);
 *  - the same `receiptId` is never applied twice (the relay already
 *    deduplicates, this protects against a second relay or a replay).
 */
export class ReceiptStore {
    private readonly records = new Map<string, ReceiptRecord>();
    private readonly seenReceiptIds = new Map<string, number>();
    private readonly listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    get size(): number {
        return this.records.size;
    }

    get(messageId: string): ReceiptRecord | undefined {
        return this.records.get(messageId);
    }

    hasSeenReceipt(receiptId: string): boolean {
        return this.seenReceiptIds.has(receiptId);
    }

    /** @returns true when the visible state changed. */
    add(record: ReceiptRecord, now = Date.now()): boolean {
        if (!isReceiptRecord(record)) return false;
        if (this.seenReceiptIds.has(record.receiptId)) return false;

        const existing = this.records.get(record.messageId);
        if (existing) {
            if (existing.messageVersion >= record.messageVersion) {
                this.rememberReceiptId(record.receiptId, now);
                return false;
            }
        }

        this.rememberReceiptId(record.receiptId, now);
        this.records.set(record.messageId, record);
        this.emit();
        return true;
    }

    removeMessages(messageIds: Iterable<string>): boolean {
        let changed = false;
        for (const messageId of messageIds) {
            changed = this.records.delete(messageId) || changed;
        }
        if (changed) this.emit();
        return changed;
    }

    clear(): void {
        if (this.records.size === 0 && this.seenReceiptIds.size === 0) return;
        this.records.clear();
        this.seenReceiptIds.clear();
        this.emit();
    }

    prune(now: number = Date.now(), maxEntries: number = LIMITS.maxReceipts, ttlMs: number = LIMITS.receiptTtlMs): boolean {
        let changed = false;

        for (const [messageId, record] of this.records) {
            if (now - record.receivedAt > ttlMs) {
                this.records.delete(messageId);
                changed = true;
            }
        }

        if (this.records.size > maxEntries) {
            const sorted = [...this.records.entries()]
                .sort((a, b) => a[1].receivedAt - b[1].receivedAt);
            const excess = this.records.size - maxEntries;
            for (let i = 0; i < excess; i++) {
                const entry = sorted[i];
                if (!entry) break;
                this.records.delete(entry[0]);
                changed = true;
            }
        }

        for (const [receiptId, expiresAt] of this.seenReceiptIds) {
            if (expiresAt <= now) {
                this.seenReceiptIds.delete(receiptId);
                changed = true;
            }
        }

        if (changed) this.emit();
        return changed;
    }

    serialize(): SerializedReceipts {
        return { v: 1, receipts: [...this.records.values()] };
    }

    deserialize(value: unknown): void {
        this.records.clear();
        this.seenReceiptIds.clear();

        if (typeof value !== "object" || value === null) {
            this.emit();
            return;
        }

        const data = value as Record<string, unknown>;
        if (data.v !== 1 || !Array.isArray(data.receipts)) {
            this.emit();
            return;
        }

        for (const item of data.receipts) {
            if (!isReceiptRecord(item)) continue;
            const existing = this.records.get(item.messageId);
            if (existing && existing.messageVersion >= item.messageVersion) continue;
            this.records.set(item.messageId, item);
            this.seenReceiptIds.set(item.receiptId, item.receivedAt + LIMITS.receiptIdMemoryMs);
        }

        this.emit();
    }

    private rememberReceiptId(receiptId: string, now: number): void {
        this.seenReceiptIds.set(receiptId, now + LIMITS.receiptIdMemoryMs);

        if (this.seenReceiptIds.size > LIMITS.maxReceipts * 2) {
            const excess = this.seenReceiptIds.size - LIMITS.maxReceipts;
            let removed = 0;
            for (const receiptId of this.seenReceiptIds.keys()) {
                this.seenReceiptIds.delete(receiptId);
                if (++removed >= excess) break;
            }
        }
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

export function isReceiptRecord(value: unknown): value is ReceiptRecord {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;

    return isUuid(record.receiptId)
        && isSnowflake(record.from)
        && isSnowflake(record.to)
        && isSnowflake(record.channelId)
        && isSnowflake(record.messageId)
        && isSafeInt(record.messageVersion)
        && isSafeInt(record.readAt)
        && isSafeInt(record.receivedAt);
}

function isSafeInt(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
