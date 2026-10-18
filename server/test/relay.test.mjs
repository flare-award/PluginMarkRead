/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { WebSocket } from "ws";

import { createLogger } from "../dist/logger.js";
import {
    authSigningInput,
    base64UrlEncode,
    receiptSigningInput
} from "../dist/protocol.js";
import { RelayServer } from "../dist/relay.js";
import { RelayState } from "../dist/store.js";

const USER_A = "123456789012345678";
const USER_B = "987654321098765432";
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";
const DEVICE_A = "8a1b9c7d-1e2f-4a3b-9c8d-7e6f5a4b3c2d";
const DEVICE_B = "9a1b9c7d-1e2f-4a3b-9c8d-7e6f5a4b3c2e";

const encoder = new TextEncoder();

async function createIdentity() {
    const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    return { pair, publicKey: base64UrlEncode(spki) };
}

async function sign(identity, input) {
    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        identity.pair.privateKey,
        encoder.encode(input)
    );
    return base64UrlEncode(new Uint8Array(signature));
}

async function signAuth(identity, userId, deviceId, nonce) {
    return {
        type: "auth",
        v: 1,
        userId,
        deviceId,
        nonce,
        publicKey: identity.publicKey,
        signature: await sign(identity, authSigningInput({ userId, deviceId, nonce })),
        clientVersion: "1.0.0"
    };
}

async function signReceipt(identity, overrides = {}) {
    const payload = {
        v: 1,
        kind: "read-receipt",
        receiptId: overrides.receiptId ?? crypto.randomUUID(),
        from: overrides.from ?? USER_B,
        to: overrides.to ?? USER_A,
        channelId: CHANNEL,
        messageId: MESSAGE,
        messageVersion: 0,
        readAt: Date.now(),
        sentAt: Date.now(),
        ...overrides
    };
    return {
        payload,
        publicKey: identity.publicKey,
        signature: await sign(identity, receiptSigningInput(payload))
    };
}

class Client {
    constructor(socket) {
        this.socket = socket;
        this.messages = [];
        this.waiters = [];

        socket.on("message", data => {
            const message = JSON.parse(data.toString());
            this.messages.push(message);
            for (const waiter of [...this.waiters]) {
                if (waiter.predicate(message)) {
                    this.waiters.splice(this.waiters.indexOf(waiter), 1);
                    waiter.resolve(message);
                }
            }
        });
    }

    static async connect(url, options = {}) {
        const socket = new WebSocket(url, options);
        const client = new Client(socket);
        await new Promise((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
        });
        return client;
    }

    send(message) {
        this.socket.send(JSON.stringify(message));
    }

    waitFor(predicate, timeoutMs = 3_000) {
        const existing = this.messages.find(predicate);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter(waiter => waiter.resolve !== wrappedResolve);
                reject(new Error("Timed out waiting for a relay message"));
            }, timeoutMs);

            const wrappedResolve = message => {
                clearTimeout(timer);
                resolve(message);
            };

            this.waiters.push({ predicate, resolve: wrappedResolve });
        });
    }

    async authenticate(identity, userId = USER_A, deviceId = DEVICE_A) {
        const hello = await this.waitFor(message => message.type === "hello");
        this.send(await signAuth(identity, userId, deviceId, hello.challenge));
        return this.waitFor(message => message.type === "ready" || message.type === "error");
    }

    close() {
        this.socket.close();
    }
}

describe("MarkRead relay", () => {
    let relay;
    let state;
    let url;
    let identityA;
    let identityB;

    before(async () => {
        identityA = await createIdentity();
        identityB = await createIdentity();

        state = new RelayState(undefined, {
            maxQueuedPerUser: 50,
            inboxTtlMs: 60_000,
            logger: createLogger("silent")
        });
        await state.load();

        relay = new RelayServer({
            host: "127.0.0.1",
            port: 0,
            allowedOrigins: [],
            maxConnectionsPerUser: 5,
            maxConnectionsTotal: 100,
            authTimeoutMs: 5_000,
            idleTimeoutMs: 60_000,
            maxFrameBytes: 16 * 1024,
            receiptBurst: 4,
            receiptsPerMinute: 60,
            watchBurst: 10,
            watchesPerMinute: 60,
            inboxTtlMs: 60_000,
            maxQueuedPerUser: 50,
            logLevel: "silent"
        }, createLogger("silent"), state);

        const address = await relay.start();
        url = `ws://127.0.0.1:${address.port}`;
    });

    after(async () => {
        await relay.stop();
    });

    it("rejects unauthenticated frames", async () => {
        const client = await Client.connect(url);
        client.send({ type: "ping", t: 1 });

        const error = await client.waitFor(message => message.type === "error");
        assert.equal(error.code, "not_authenticated");
        assert.equal(error.fatal, true);
        client.close();
    });

    it("rejects an invalid authentication signature", async () => {
        const client = await Client.connect(url);
        const hello = await client.waitFor(message => message.type === "hello");
        const identity = await createIdentity();

        client.send({
            type: "auth",
            v: 1,
            userId: "555555555555555555",
            deviceId: DEVICE_A,
            nonce: hello.challenge,
            publicKey: identity.publicKey,
            signature: "A".repeat(86),
            clientVersion: "1.0.0"
        });

        const error = await client.waitFor(message => message.type === "error");
        assert.equal(error.code, "auth_failed");
        client.close();
    });

    it("authenticates two users and reports presence", async () => {
        const a = await Client.connect(url);
        const b = await Client.connect(url);

        const readyA = await a.authenticate(identityA, USER_A, DEVICE_A);
        const readyB = await b.authenticate(identityB, USER_B, DEVICE_B);
        assert.equal(readyA.type, "ready");
        assert.equal(readyB.type, "ready");

        // A watches B; the relay answers with B's presence and fingerprint.
        a.send({ type: "watch", userId: USER_B });
        const peer = await a.waitFor(message => message.type === "peer" && message.userId === USER_B);
        assert.equal(peer.registered, true);
        assert.equal(peer.online, true);
        assert.match(peer.keyFingerprint, /^[0-9A-F]{4}-/);

        a.close();
        b.close();
    });

    it("delivers a verified receipt and rejects tampering", async () => {
        const a = await Client.connect(url);
        const b = await Client.connect(url);
        await a.authenticate(identityA, USER_A, DEVICE_A);
        await b.authenticate(identityB, USER_B, DEVICE_B);

        const receipt = await signReceipt(identityB, { from: USER_B, to: USER_A });
        b.send({ type: "receipt", receipt });

        const delivered = await a.waitFor(message => message.type === "receipt");
        assert.equal(delivered.receipt.payload.from, USER_B);
        assert.equal(delivered.receipt.payload.to, USER_A);

        // Same receipt id twice: the relay must deduplicate.
        b.send({ type: "receipt", receipt });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(a.messages.filter(message => message.type === "receipt").length, 1);

        // A receipt signed by B but claiming to be from A is rejected.
        const forged = await signReceipt(identityB, {
            from: USER_A,
            to: USER_B,
            receiptId: crypto.randomUUID()
        });
        b.send({ type: "receipt", receipt: forged });
        const error = await b.waitFor(message => message.type === "error" && message.code === "invalid_receipt");
        assert.equal(error.fatal, false);

        a.close();
        b.close();
    });

    it("queues receipts for an offline recipient", async () => {
        const firstA = await Client.connect(url);
        await firstA.authenticate(identityA, USER_A, DEVICE_A);
        firstA.close();
        await new Promise(resolve => setTimeout(resolve, 50));

        const b = await Client.connect(url);
        await b.authenticate(identityB, USER_B, DEVICE_B);

        const receipt = await signReceipt(identityB, {
            from: USER_B,
            to: USER_A,
            receiptId: crypto.randomUUID()
        });
        b.send({ type: "receipt", receipt });
        await new Promise(resolve => setTimeout(resolve, 100));

        const secondA = await Client.connect(url);
        const hello = await secondA.waitFor(message => message.type === "hello");
        secondA.send(await signAuth(identityA, USER_A, DEVICE_A, hello.challenge));

        const ready = await secondA.waitFor(message => message.type === "ready");
        assert.equal(ready.pendingReceipts, 1);

        const pending = await secondA.waitFor(message => message.type === "receipt");
        assert.equal(pending.receipt.payload.receiptId, receipt.payload.receiptId);

        b.close();
        secondA.close();
    });

    it("rate limits bursts of receipts", async () => {
        const a = await Client.connect(url);
        const b = await Client.connect(url);
        await a.authenticate(identityA, USER_A, DEVICE_A);
        await b.authenticate(identityB, USER_B, DEVICE_B);

        // The bucket holds 4 receipts; send more than that.
        for (let i = 0; i < 8; i++) {
            b.send({
                type: "receipt",
                receipt: await signReceipt(identityB, {
                    from: USER_B,
                    to: USER_A,
                    receiptId: crypto.randomUUID()
                })
            });
        }

        const error = await b.waitFor(message => message.type === "error" && message.code === "rate_limited");
        assert.equal(error.fatal, false);

        a.close();
        b.close();
    });

    it("serves a health endpoint", async () => {
        const response = await fetch(`http://127.0.0.1:${new URL(url).port}/healthz`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.protocol, 1);
        assert.equal(typeof body.registeredUsers, "number");
    });
});
