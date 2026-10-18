/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ReceiptStore } from "./receiptStore";
import { SentLog } from "./sentLog";
import {
    ConnectionStateStore,
    OptOutStore,
    PeerStatusStore,
    PinnedPeerStore
} from "./stores";

/**
 * Process-wide stores. They are module singletons so that the connection, the
 * React components and the persistence layer all observe the same data, even
 * if the chat is rendered in several places (main window, popout, ...).
 */
export const receiptStore = new ReceiptStore();
export const sentLog = new SentLog();
export const optOutStore = new OptOutStore();
export const pinnedPeers = new PinnedPeerStore();
export const peerStatusStore = new PeerStatusStore();
export const connectionStateStore = new ConnectionStateStore();

/** Message ids whose receipt is currently being signed or queued. */
export const receiptsInFlight = new Set<string>();
