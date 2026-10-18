/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { resetDeviceId, resetIdentity } from "./identity";
import { optOutStore, pinnedPeers, receiptStore, sentLog } from "./state";

const logger = new Logger("MarkRead");

const KEYS = {
    receipts: "markread.receipts.v1",
    sent: "markread.sent.v1",
    optOut: "markread.optout.v1",
    pins: "markread.pins.v1"
} as const;

const SAVE_DEBOUNCE_MS = 750;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePromise: Promise<void> | undefined;
let dirty = false;
let started = false;
let clearInProgress = false;
let unsubscribers: Array<() => void> = [];

async function read(key: string): Promise<unknown> {
    try {
        return await DataStore.get(key);
    } catch (error) {
        logger.warn(`Could not read ${key}`, error);
        return undefined;
    }
}

async function write(): Promise<void> {
    dirty = false;

    try {
        await Promise.all([
            DataStore.set(KEYS.receipts, receiptStore.serialize()),
            DataStore.set(KEYS.sent, sentLog.serialize()),
            DataStore.set(KEYS.optOut, optOutStore.serialize()),
            DataStore.set(KEYS.pins, pinnedPeers.serialize())
        ]);
    } catch (error) {
        dirty = true;
        logger.warn("Could not persist MarkRead state", error);
    }
}

function scheduleSave(): void {
    if (clearInProgress) return;

    dirty = true;
    if (saveTimer != null) return;

    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        savePromise = write().finally(() => {
            savePromise = undefined;
        });
    }, SAVE_DEBOUNCE_MS);
}

function subscribe(): void {
    unsubscribers = [
        receiptStore.subscribe(scheduleSave),
        sentLog.subscribe(scheduleSave),
        optOutStore.subscribe(scheduleSave),
        pinnedPeers.subscribe(scheduleSave)
    ];
}

function unsubscribe(): void {
    for (const off of unsubscribers) off();
    unsubscribers = [];
}

/** Loads all persisted stores. Safe to call more than once. */
export async function loadPersistence(): Promise<void> {
    if (started) return;
    started = true;

    const [receipts, sent, optOut, pins] = await Promise.all([
        read(KEYS.receipts),
        read(KEYS.sent),
        read(KEYS.optOut),
        read(KEYS.pins)
    ]);

    receiptStore.deserialize(receipts);
    sentLog.deserialize(sent);
    optOutStore.deserialize(optOut);
    pinnedPeers.deserialize(pins);

    receiptStore.prune();
    sentLog.prune();

    subscribe();
    logger.info("Loaded local MarkRead data", {
        receipts: receiptStore.size,
        sent: sentLog.size,
        optOuts: optOutStore.list().length,
        pinnedPeers: pinnedPeers.list().length
    });
}

/** Persists pending changes immediately. */
export async function flushPersistence(): Promise<void> {
    if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }

    if (savePromise) await savePromise;
    if (dirty) await write();
}

/** Stops persistence timers and subscriptions (plugin disable). */
export function stopPersistence(): void {
    unsubscribe();
    if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }
    started = false;
    dirty = false;
}

/**
 * Deletes local MarkRead data. Used from the settings panel after an explicit
 * confirmation by the user.
 */
export async function clearLocalData(options: { includeIdentity: boolean; }): Promise<void> {
    clearInProgress = true;
    unsubscribe();

    if (saveTimer != null) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }

    receiptStore.clear();
    sentLog.clear();
    optOutStore.clear();
    pinnedPeers.clear();

    try {
        await DataStore.delMany(Object.values(KEYS));
    } catch (error) {
        logger.warn("Could not delete local MarkRead data", error);
    }

    if (options.includeIdentity) {
        await resetIdentity();
        await resetDeviceId();
    }

    clearInProgress = false;
    dirty = false;
    subscribe();
    started = true;
}
