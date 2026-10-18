/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "./logger.js";
import {
    fingerprintPublicKey,
    isSnowflake,
    type QueuedReceipt,
    type SignedReceipt,
    validateSignedReceipt
} from "./protocol.js";

export interface RegistryEntry {
    userId: string;
    publicKey: string;
    fingerprint: string;
    registeredAt: number;
    lastSeenAt: number;
}

interface PersistedState {
    v: 1;
    registry: Record<string, Omit<RegistryEntry, "userId">>;
    inbox: Record<string, QueuedReceipt[]>;
}

export type RegisterResult = "created" | "same" | "mismatch";

const SAVE_DEBOUNCE_MS = 750;
const FILE_NAME = "markread-state.json";

/**
 * In-memory state with optional atomic JSON persistence.
 *
 * The registry maps a Discord user id to the first public key that was ever
 * seen for it (trust on first use). The inbox holds receipts for users that
 * were offline; it is bounded in both time and size.
 */
export class RelayState {
    private readonly registry = new Map<string, RegistryEntry>();
    private readonly inbox = new Map<string, QueuedReceipt[]>();
    private readonly filePath?: string;
    private saveTimer?: NodeJS.Timeout;
    private savePromise?: Promise<void>;
    private dirty = false;
    private stopped = false;

    constructor(
        dataDir: string | undefined,
        private readonly options: {
            maxQueuedPerUser: number;
            inboxTtlMs: number;
            logger: Logger;
        }
    ) {
        this.filePath = dataDir ? join(dataDir, FILE_NAME) : undefined;
    }

    async load(): Promise<void> {
        if (!this.filePath) return;

        let raw: string;
        try {
            raw = await readFile(this.filePath, "utf8");
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return;
            throw error;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            this.options.logger.error("State file is not valid JSON, starting empty");
            return;
        }

        if (!isPersistedState(parsed)) {
            this.options.logger.error("State file has an unsupported format, starting empty");
            return;
        }

        for (const [userId, entry] of Object.entries(parsed.registry)) {
            if (!isSnowflake(userId) || !isRegistryEntry(entry)) continue;
            this.registry.set(userId, { userId, ...entry });
        }

        const now = Date.now();
        for (const [userId, receipts] of Object.entries(parsed.inbox)) {
            if (!isSnowflake(userId) || !Array.isArray(receipts)) continue;
            const valid = receipts
                .filter(isQueuedReceipt)
                .filter(item => now - item.receivedAt <= this.options.inboxTtlMs)
                .slice(-this.options.maxQueuedPerUser);
            if (valid.length > 0) this.inbox.set(userId, valid);
        }

        this.options.logger.info("Loaded state", {
            users: this.registry.size,
            queuedUsers: this.inbox.size
        });
    }

    hasUser(userId: string): boolean {
        return this.registry.has(userId);
    }

    getEntry(userId: string): RegistryEntry | undefined {
        return this.registry.get(userId);
    }

    getPublicKey(userId: string): string | undefined {
        return this.registry.get(userId)?.publicKey;
    }

    async register(userId: string, publicKey: string, now: number): Promise<RegisterResult> {
        const existing = this.registry.get(userId);

        if (existing) {
            existing.lastSeenAt = now;
            this.scheduleSave();
            return existing.publicKey === publicKey ? "same" : "mismatch";
        }

        const entry: RegistryEntry = {
            userId,
            publicKey,
            fingerprint: await fingerprintPublicKey(publicKey),
            registeredAt: now,
            lastSeenAt: now
        };
        this.registry.set(userId, entry);
        this.scheduleSave();
        return "created";
    }

    touch(userId: string, now: number): void {
        const entry = this.registry.get(userId);
        if (!entry) return;
        entry.lastSeenAt = now;
        this.scheduleSave();
    }

    enqueue(userId: string, receipt: SignedReceipt, receivedAt: number): void {
        const queue = this.inbox.get(userId) ?? [];
        queue.push({ receipt, receivedAt });
        while (queue.length > this.options.maxQueuedPerUser) queue.shift();
        this.inbox.set(userId, queue);
        this.scheduleSave();
    }

    takeQueued(userId: string, now: number): QueuedReceipt[] {
        const queue = this.inbox.get(userId);
        if (!queue || queue.length === 0) return [];

        this.inbox.delete(userId);
        this.scheduleSave();

        const fresh = queue.filter(item => now - item.receivedAt <= this.options.inboxTtlMs);
        return fresh;
    }

    queuedCount(userId: string): number {
        const queue = this.inbox.get(userId);
        if (!queue) return 0;
        const now = Date.now();
        return queue.filter(item => now - item.receivedAt <= this.options.inboxTtlMs).length;
    }

    countUsers(): number {
        return this.registry.size;
    }

    countInboxUsers(): number {
        return this.inbox.size;
    }

    /** Removes a user's key registration and queued receipts. */
    async resetUser(userId: string): Promise<boolean> {
        const removed = this.registry.delete(userId);
        const removedInbox = this.inbox.delete(userId);
        if (removed || removedInbox) await this.flush();
        return removed || removedInbox;
    }

    /** Persists pending changes and stops the debounce timer. */
    async flush(): Promise<void> {
        if (this.saveTimer != null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }

        if (this.savePromise) {
            await this.savePromise;
        }

        if (this.dirty) {
            await this.saveNow();
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.saveTimer != null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
    }

    private scheduleSave(): void {
        if (!this.filePath || this.stopped) return;
        this.dirty = true;
        if (this.saveTimer != null) return;

        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.savePromise = this.saveNow().finally(() => {
                this.savePromise = undefined;
            });
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }

    private async saveNow(): Promise<void> {
        if (!this.filePath) {
            this.dirty = false;
            return;
        }

        this.dirty = false;

        const data: PersistedState = {
            v: 1,
            registry: Object.fromEntries(
                [...this.registry].map(([userId, { userId: _userId, ...entry }]) => [userId, entry])
            ),
            inbox: Object.fromEntries(this.inbox)
        };

        const temp = `${this.filePath}.tmp`;
        try {
            await mkdir(dirname(this.filePath), { recursive: true });
            await writeFile(temp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
            await rename(temp, this.filePath);
        } catch (error) {
            this.dirty = true;
            this.options.logger.error("Could not persist state", error);
        }
    }
}

function isRegistryEntry(value: unknown): value is Omit<RegistryEntry, "userId"> {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.publicKey === "string"
        && typeof entry.fingerprint === "string"
        && typeof entry.registeredAt === "number"
        && Number.isSafeInteger(entry.registeredAt)
        && typeof entry.lastSeenAt === "number"
        && Number.isSafeInteger(entry.lastSeenAt);
}

function isQueuedReceipt(value: unknown): value is QueuedReceipt {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Record<string, unknown>;
    return validateSignedReceipt(item.receipt) != null
        && typeof item.receivedAt === "number"
        && Number.isSafeInteger(item.receivedAt);
}

function isPersistedState(value: unknown): value is PersistedState {
    if (typeof value !== "object" || value === null) return false;
    const data = value as Record<string, unknown>;
    return data.v === 1
        && typeof data.registry === "object" && data.registry !== null
        && typeof data.inbox === "object" && data.inbox !== null;
}
