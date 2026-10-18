/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, UserStore, useStateFromStores } from "@webpack/common";

import type { ReceiptRecord } from "../core/receiptStore";
import {
    connectionStateStore,
    optOutStore,
    peerStatusStore,
    pinnedPeers,
    receiptStore
} from "../core/state";
import type { ConnectionState, PeerStatus, PinnedPeer } from "../core/stores";
import { settings } from "../settings";

export function useCurrentUserId(): string | null {
    return useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id ?? null);
}

export function useReceipt(messageId: string): ReceiptRecord | undefined {
    return React.useSyncExternalStore(
        receiptStore.subscribe,
        () => receiptStore.get(messageId)
    );
}

export function useOptOut(channelId: string): boolean {
    return React.useSyncExternalStore(
        optOutStore.subscribe,
        () => optOutStore.has(channelId)
    );
}

export function usePeerStatus(userId: string | null): PeerStatus | undefined {
    return React.useSyncExternalStore(
        peerStatusStore.subscribe,
        () => userId ? peerStatusStore.get(userId) : undefined
    );
}

export function useConnectionState(): ConnectionState {
    return React.useSyncExternalStore(
        connectionStateStore.subscribe,
        () => connectionStateStore.get()
    );
}

export function useSettings() {
    return settings.use([
        "exchangeEnabled",
        "shareReadReceipts",
        "serverUrl",
        "dwellMs",
        "showSentChecks",
        "indicatorSize",
        "readColor",
        "showReadTime"
    ]);
}

function useStoreTick(store: { subscribe(listener: () => void): () => void; }): void {
    const [, forceUpdate] = React.useReducer((value: number) => value + 1, 0);

    React.useEffect(() => store.subscribe(forceUpdate), [store]);
}

export function usePinnedPeers(): PinnedPeer[] {
    useStoreTick(pinnedPeers);
    return pinnedPeers.list();
}

export function useOptOutChannels(): string[] {
    useStoreTick(optOutStore);
    return optOutStore.list();
}
