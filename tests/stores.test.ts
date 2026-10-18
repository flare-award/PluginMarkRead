/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ReceiptStore, type ReceiptRecord } from "../markRead/core/receiptStore";
import { SentLog } from "../markRead/core/sentLog";
import {
    ConnectionStateStore,
    OptOutStore,
    PeerStatusStore,
    PinnedPeerStore
} from "../markRead/core/stores";

const PEER = "987654321098765432";
const SELF = "123456789012345678";
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";
const UUID_1 = "2f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f";
const UUID_2 = "3f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f";

function record(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
    return {
        receiptId: UUID_1,
        from: PEER,
        to: SELF,
        channelId: CHANNEL,
        messageId: MESSAGE,
        messageVersion: 0,
        readAt: 1_700_000_000_000,
        receivedAt: 1_700_000_001_000,
        ...overrides
    };
}

test("receipt store applies the newest version and ignores duplicates", () => {
    const store = new ReceiptStore();
    const listener = { calls: 0 };
    const off = store.subscribe(() => listener.calls++);

    assert.equal(store.add(record()), true);
    assert.equal(store.add(record()), false, "the same receiptId is a replay");
    assert.equal(store.add(record({ receiptId: UUID_2 })), false, "same version is not newer");
    assert.equal(store.size, 1);
    assert.equal(listener.calls, 1);

    assert.equal(store.add(record({ receiptId: "9f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f", messageVersion: 5, receivedAt: 1_700_000_002_000 })), true);
    assert.equal(store.get(MESSAGE)?.messageVersion, 5);
    assert.equal(listener.calls, 2);

    // An older edit confirmation must not replace the newer one.
    assert.equal(store.add(record({ receiptId: "4f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f", messageVersion: 2 })), false);
    assert.equal(store.get(MESSAGE)?.messageVersion, 5);

    off();
    store.clear();
    assert.equal(listener.calls, 2);
    assert.equal(store.size, 0);
});

test("receipt store round trips through serialization and drops invalid rows", () => {
    const store = new ReceiptStore();
    store.add(record());
    store.add(record({ receiptId: UUID_2, messageId: "333333333333333333", messageVersion: 9 }));

    const serialized = store.serialize();
    assert.equal(serialized.v, 1);
    assert.equal(serialized.receipts.length, 2);

    const restored = new ReceiptStore();
    restored.deserialize(serialized);
    assert.equal(restored.size, 2);
    assert.equal(restored.get(MESSAGE)?.receiptId, UUID_1);

    const dirty = {
        v: 1,
        receipts: [
            { ...record(), receiptId: "not-a-uuid" },
            { ...record({ receiptId: "5f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f" }), messageId: "nope" },
            record({ receiptId: "6f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f", messageId: "444444444444444444", readAt: -1 })
        ]
    };
    const filtered = new ReceiptStore();
    filtered.deserialize(dirty);
    assert.equal(filtered.size, 0);

    filtered.deserialize({ v: 2, receipts: [] });
    assert.equal(filtered.size, 0);
});

test("receipt store removes deleted messages and prunes old entries", () => {
    const store = new ReceiptStore();
    store.add(record({ receivedAt: 1_000 }));
    store.add(record({ receiptId: UUID_2, messageId: "333333333333333333", receivedAt: 2_000 }));

    assert.equal(store.removeMessages([MESSAGE]), true);
    assert.equal(store.removeMessages([MESSAGE]), false);
    assert.equal(store.size, 1);

    assert.equal(store.prune(2_000 + 10, 10, 5), true);
    assert.equal(store.size, 0);
});

test("sent log deduplicates by message and version", () => {
    const log = new SentLog();
    assert.equal(log.has(MESSAGE, 0), false);

    log.mark(MESSAGE, { channelId: CHANNEL, messageVersion: 0, sentAt: 1_000 });
    assert.equal(log.has(MESSAGE, 0), true);
    assert.equal(log.has(MESSAGE, 1), false);

    log.mark(MESSAGE, { channelId: CHANNEL, messageVersion: 0, sentAt: 2_000 });
    assert.equal(log.get(MESSAGE)?.sentAt, 1_000, "same version is not overwritten");

    log.mark(MESSAGE, { channelId: CHANNEL, messageVersion: 1, sentAt: 3_000 });
    assert.equal(log.get(MESSAGE)?.sentAt, 3_000);

    const restored = new SentLog();
    restored.deserialize(log.serialize());
    assert.equal(restored.has(MESSAGE, 1), true);

    restored.deserialize({ v: 1, entries: { [MESSAGE]: { channelId: CHANNEL, messageVersion: -1, sentAt: 0 } } });
    assert.equal(restored.has(MESSAGE, 1), false);

    restored.mark(MESSAGE, { channelId: CHANNEL, messageVersion: 1, sentAt: 3_000 });
    assert.equal(restored.removeMessages([MESSAGE]), true);
    assert.equal(restored.size, 0);
});

test("opt-out store toggles, bounds and serializes channels", () => {
    const store = new OptOutStore();
    assert.equal(store.toggle(CHANNEL), true);
    assert.equal(store.has(CHANNEL), true);
    assert.equal(store.toggle(CHANNEL), false);
    assert.equal(store.has(CHANNEL), false);

    store.add(CHANNEL);
    store.add("not-a-snowflake");
    assert.deepEqual(store.list(), [CHANNEL]);
    assert.deepEqual(store.serialize(), { v: 1, channels: [CHANNEL] });

    const restored = new OptOutStore();
    restored.deserialize({ v: 1, channels: [CHANNEL, "bad", 42] });
    assert.deepEqual(restored.list(), [CHANNEL]);

    assert.equal(restored.remove(CHANNEL), true);
    assert.equal(restored.remove(CHANNEL), false);
});

test("pinned peer store is trust on first use", () => {
    const store = new PinnedPeerStore();
    assert.equal(store.pin(PEER, "key-a", 1_000), "new");
    assert.equal(store.pin(PEER, "key-a", 2_000), "same");
    assert.equal(store.pin(PEER, "key-b", 3_000), "mismatch");
    assert.equal(store.get(PEER)?.publicKey, "key-a");

    const restored = new PinnedPeerStore();
    restored.deserialize(store.serialize());
    assert.equal(restored.get(PEER)?.publicKey, "key-a");
    assert.equal(restored.get(PEER)?.pinnedAt, 1_000);

    assert.equal(restored.forget(PEER), true);
    assert.equal(restored.forget(PEER), false);

    restored.deserialize({ v: 1, peers: { [PEER]: { publicKey: "k" }, bad: { publicKey: "k" }, ["123456789012345679"]: { publicKey: 42 } } });
    assert.equal(restored.list().length, 1);
});

test("peer status and connection state notify subscribers", () => {
    const peers = new PeerStatusStore();
    let calls = 0;
    peers.subscribe(() => calls++);

    peers.set({ userId: PEER, registered: true, online: false, watchedAt: 1, receivedAt: 1 });
    peers.set({ userId: PEER, registered: true, online: true, watchedAt: 2, receivedAt: 2 });
    assert.equal(calls, 2);
    assert.equal(peers.get(PEER)?.online, true);

    peers.setError(PEER, "boom");
    assert.equal(peers.get(PEER)?.error, "boom");
    assert.equal(calls, 3);

    peers.clear();
    assert.equal(peers.get(PEER), undefined);

    const connection = new ConnectionStateStore();
    let stateCalls = 0;
    connection.subscribe(() => stateCalls++);

    assert.equal(connection.isOnline(), false);
    connection.set({ phase: "online", url: "wss://x", since: 1 });
    assert.equal(connection.isOnline(), true);
    assert.equal(stateCalls, 1);

    connection.clear();
    assert.equal(connection.get().phase, "disabled");
    assert.equal(stateCalls, 2);
});
