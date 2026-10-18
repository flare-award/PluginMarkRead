/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MarkReadConnection, type ConnectionLogger } from "../markRead/core/connection";
import { ConnectionStateStore, PeerStatusStore } from "../markRead/core/stores";
import {
    exportPublicKey,
    generateIdentityKeyPair,
    signReceiptPayload,
    verifyAuth,
    type SignedReceipt
} from "../markRead/protocol";

const SELF = "123456789012345678";
const PEER = "987654321098765432";
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";
const DEVICE = "8a1b9c7d-1e2f-4a3b-9c8d-7e6f5a4b3c2d";
const HELLO_CHALLENGE = "A".repeat(43);

const logger: ConnectionLogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { }
};

class FakeSocket {
    readyState = 0;
    sent: string[] = [];
    closed = false;

    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown; }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string; }) => void) | null = null;

    send(data: string): void {
        if (this.readyState !== 1) throw new Error("socket is not open");
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(message: unknown): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    sentMessages(): any[] {
        return this.sent.map(frame => JSON.parse(frame));
    }
}

async function tick(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

/** Waits for asynchronous crypto work (signing/verification) to finish. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function makeIdentity() {
    const pair = await generateIdentityKeyPair();
    return {
        privateKey: pair.privateKey,
        publicKey: await exportPublicKey(pair.publicKey)
    };
}

function hello() {
    return {
        type: "hello",
        v: 1,
        challenge: HELLO_CHALLENGE,
        serverVersion: "1.0.0",
        serverTime: Date.now(),
        limits: {
            maxFrameBytes: 16_384,
            receiptBurst: 120,
            receiptsPerMinute: 240,
            watchPerMinute: 60
        }
    };
}

function ready() {
    return {
        type: "ready",
        userId: SELF,
        sessionId: "2f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f",
        serverTime: Date.now(),
        pendingReceipts: 0
    };
}

interface Harness {
    connection: MarkReadConnection;
    sockets: FakeSocket[];
    status: ConnectionStateStore;
    peers: PeerStatusStore;
    onReceipt: SignedReceipt[];
    setNow(value: number): void;
}

async function connect(t: { after(fn: () => void): void; }): Promise<Harness> {
    const identity = await makeIdentity();
    const sockets: FakeSocket[] = [];
    const status = new ConnectionStateStore();
    const peers = new PeerStatusStore();
    const onReceipt: SignedReceipt[] = [];
    let now = 10_000;

    const connection = new MarkReadConnection({
        userId: SELF,
        config: { enabled: true, serverUrl: "ws://localhost:8787" },
        statusStore: status,
        peerStore: peers,
        getIdentity: async () => identity,
        getDeviceId: async () => DEVICE,
        onReceipt: receipt => {
            onReceipt.push(receipt);
        },
        logger,
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
        now: () => now
    });

    t.after(() => connection.stop());
    connection.start();

    return {
        connection,
        sockets,
        status,
        peers,
        onReceipt,
        setNow: value => {
            now = value;
        }
    };
}

test("authenticates with a challenge response", async t => {
    const harness = await connect(t);
    const socket = harness.sockets[0]!;
    assert.ok(socket, "a socket was created");
    assert.equal(harness.status.get().phase, "connecting");

    socket.open();
    assert.equal(harness.status.get().phase, "authenticating");

    socket.receive(hello());
    await waitFor(() => socket.sentMessages().length > 0);

    const auth = socket.sentMessages()[0];
    assert.equal(auth.type, "auth");
    assert.equal(auth.userId, SELF);
    assert.equal(auth.deviceId, DEVICE);
    assert.equal(auth.nonce, HELLO_CHALLENGE);
    assert.equal(await verifyAuth(auth), true);

    socket.receive(ready());
    await tick();

    assert.equal(harness.connection.getPhase(), "online");
    assert.equal(harness.status.get().phase, "online");
    assert.equal(harness.status.get().error, undefined);
});

test("queues receipts offline and flushes them after ready", async t => {
    const harness = await connect(t);
    const socket = harness.sockets[0]!;
    const identity = await makeIdentity();
    const signed = await signReceiptPayload(identity.privateKey, identity.publicKey, {
        v: 1,
        kind: "read-receipt",
        receiptId: "2f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f",
        from: SELF,
        to: PEER,
        channelId: CHANNEL,
        messageId: MESSAGE,
        messageVersion: 0,
        readAt: 1_000,
        sentAt: 1_000
    });

    assert.equal(harness.connection.sendReceipt(signed), true);
    assert.equal(socket.sent.length, 0, "nothing is sent before authentication");

    socket.open();
    socket.receive(hello());
    await tick();
    socket.receive(ready());
    await tick();

    const frames = socket.sentMessages();
    assert.equal(frames.filter(frame => frame.type === "receipt").length, 1);
});

test("verifies incoming receipts and ignores invalid or foreign ones", async t => {
    const harness = await connect(t);
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive(hello());
    await tick();
    socket.receive(ready());
    await tick();

    const identity = await makeIdentity();
    const payload = {
        v: 1 as const,
        kind: "read-receipt" as const,
        receiptId: "2f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f",
        from: PEER,
        to: SELF,
        channelId: CHANNEL,
        messageId: MESSAGE,
        messageVersion: 0,
        readAt: 1_000,
        sentAt: 1_000
    };
    const signed = await signReceiptPayload(identity.privateKey, identity.publicKey, payload);

    socket.receive({ type: "receipt", receipt: signed, receivedAt: 1_500 });
    await waitFor(() => harness.onReceipt.length === 1);
    assert.equal(harness.onReceipt.length, 1);
    assert.equal(harness.onReceipt[0]!.payload.receiptId, payload.receiptId);

    socket.receive({
        type: "receipt",
        receipt: { ...signed, payload: { ...payload, readAt: payload.readAt - 1 } },
        receivedAt: 1_600
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(harness.onReceipt.length, 1, "tampered receipts are dropped");

    socket.receive({
        type: "receipt",
        receipt: { ...signed, payload: { ...payload, to: PEER } },
        receivedAt: 1_700
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(harness.onReceipt.length, 1, "receipts for other users are dropped");
});

test("peer messages update the peer store", async t => {
    const harness = await connect(t);
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive(hello());
    await tick();
    socket.receive(ready());
    await tick();

    socket.receive({
        type: "peer",
        userId: PEER,
        registered: true,
        online: true,
        keyFingerprint: "ABCD-EF01-2345-6789",
        watchedAt: 42
    });
    await tick();

    const status = harness.peers.get(PEER);
    assert.equal(status?.registered, true);
    assert.equal(status?.online, true);
    assert.equal(status?.keyFingerprint, "ABCD-EF01-2345-6789");
    assert.equal(status?.watchedAt, 42);
});

test("watch requests are coalesced and resent after a reconnect", async t => {
    const harness = await connect(t);
    let socket = harness.sockets[0]!;
    socket.open();
    socket.receive(hello());
    await tick();
    socket.receive(ready());
    await tick();

    harness.connection.watchPeer(PEER);
    harness.connection.watchPeer(PEER);
    assert.equal(socket.sentMessages().filter(frame => frame.type === "watch").length, 1);

    harness.setNow(20_000);
    harness.connection.watchPeer(PEER);
    assert.equal(socket.sentMessages().filter(frame => frame.type === "watch").length, 2);
});

test("fatal relay errors stop the connection", async t => {
    const harness = await connect(t);
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive(hello());
    await tick();

    socket.receive({
        type: "error",
        code: "key_mismatch",
        message: "another key is registered",
        fatal: true
    });
    await tick();

    assert.equal(harness.status.get().phase, "error");
    assert.equal(harness.status.get().error, "key_mismatch");
    assert.equal(harness.connection.getPhase(), "error");
    assert.equal(harness.sockets.length, 1, "no automatic reconnect after a fatal error");
});

test("non-fatal errors keep the connection online", async t => {
    const harness = await connect(t);
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive(hello());
    await tick();
    socket.receive(ready());
    await tick();

    socket.receive({
        type: "error",
        code: "rate_limited",
        message: "slow down",
        fatal: false,
        retryAfterMs: 500
    });
    await tick();

    assert.equal(harness.status.get().phase, "online");
    assert.equal(harness.status.get().error, "rate_limited");
});
