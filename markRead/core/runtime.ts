/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MarkReadConnection } from "./connection";

let connection: MarkReadConnection | undefined;
let active = false;
let syncHandler: (() => void) | undefined;

export function setConnection(value: MarkReadConnection | undefined): void {
    connection = value;
}

export function getConnection(): MarkReadConnection | undefined {
    return connection;
}

export function setActive(value: boolean): void {
    active = value;
}

export function isActive(): boolean {
    return active;
}

export function watchPeer(userId: string): void {
    connection?.watchPeer(userId);
}

/** Registered by the plugin entry point; called when transport settings change. */
export function setSyncHandler(handler: (() => void) | undefined): void {
    syncHandler = handler;
}

export function requestConnectionSync(): void {
    syncHandler?.();
}
