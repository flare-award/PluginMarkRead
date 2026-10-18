/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    base64UrlDecode,
    base64UrlEncode,
    canonicalJson,
    CLIENT_VERSION,
    computeBackoffMs,
    DEFAULT_LIMITS,
    exportPublicKey,
    fingerprintPublicKey,
    generateIdentityKeyPair,
    isSnowflake,
    normalizeServerUrl,
    PROTOCOL_VERSION,
    receiptSigningInput,
    signAuth,
    signReceiptPayload,
    validateClientMessage,
    validateServerMessage,
    verifyAuth,
    verifyReceipt,
    type ReceiptPayload
} from "../markRead/protocol";
import { getMessageVersion, receiptRecordFromPayload } from "../markRead/core/receiptStore";

const USER_A = "123456789012345678";
const USER_B = "987654321098765432";
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";

async function makeIdentity() {
    const pair = await generateIdentityKeyPair();
    return { pair, publicKey: await exportPublicKey(pair.publicKey) };
}

function makePayload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
    return {
        v: 1,
        kind: "read-receipt",
        receiptId: "2f1c9f0e-7a8b-4c3d-9e2f-1a2b3c4d5e6f",
        from: USER_B,
        to: USER_A,
        channelId: CHANNEL,
        messageId: MESSAGE,
        messageVersion: 0,
        readAt: 1_700_000_000_000,
        sentAt: 1_700_000_000_000,
        ...overrides
    };
}

test("canonical JSON sorts keys and rejects unsafe values", () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
    assert.equal(canonicalJson({ nested: { z: true, a: "x" }, list: [1, 2] }), '{"list":[1,2],"nested":{"a":"x","z":true}}');
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.throws(() => canonicalJson({ a: 1.5 }));
    assert.throws(() => canonicalJson({ a: 2 ** 60 }));
});

test("base64url round trips arbitrary bytes", () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([0]), new Uint8Array([255, 254, 253]), new Uint8Array([1, 2, 3, 4, 5])]) {
        const encoded = base64UrlEncode(bytes);
        assert.match(encoded, /^[A-Za-z0-9_-]*$/);
        assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
    }
    assert.throws(() => base64UrlDecode("a"));
    assert.throws(() => base64UrlDecode("!!!!"));
});

test("auth signatures verify and detect tampering", async () => {
    const { pair, publicKey } = await makeIdentity();
    const auth = await signAuth(pair.privateKey, {
        userId: USER_A,
        deviceId: "8a1b9c7d-1e2f-4a3b-9c8d-7e6f5a4b3c2d",
        nonce: "A".repeat(43),
        publicKey
    });

    assert.equal(auth.clientVersion, CLIENT_VERSION);
    assert.equal(await verifyAuth(auth), true);
    assert.equal(await verifyAuth({ ...auth, nonce: "B".repeat(43) }), false);
    assert.equal(await verifyAuth({ ...auth, userId: USER_B }), false);
    assert.equal(await verifyAuth({ ...auth, signature: "A".repeat(86) }), false);
});

test("receipt signatures bind the canonical payload", async () => {
    const { pair, publicKey } = await makeIdentity();
    const payload = makePayload();
    const signed = await signReceiptPayload(pair.privateKey, publicKey, payload);

    assert.equal(await verifyReceipt(signed), true);
    assert.equal(await verifyReceipt({
        ...signed,
        payload: { ...payload, readAt: payload.readAt + 1 }
    }), false);
    assert.equal(await verifyReceipt({
        ...signed,
        payload: { ...payload, to: USER_B }
    }), false);

    // Key order on the wire must not matter: everything is canonicalised.
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as ReceiptPayload;
    assert.equal(receiptSigningInput(reordered), receiptSigningInput(payload));
});

test("receipt and auth validators reject malformed messages", async () => {
    const { pair, publicKey } = await makeIdentity();
    const payload = makePayload();
    const signed = await signReceiptPayload(pair.privateKey, publicKey, payload);

    assert.deepEqual(validateClientMessage({ type: "receipt", receipt: signed }), { type: "receipt", receipt: signed });
    assert.equal(validateClientMessage({ type: "receipt", receipt: signed, extra: 1 }), null);
    assert.equal(validateClientMessage({ type: "receipt", receipt: { ...signed, payload: { ...payload, messageVersion: 1.5 } } }), null);
    assert.equal(validateClientMessage({ type: "receipt", receipt: { ...signed, payload: { ...payload, receiptId: "nope" } } }), null);
    assert.equal(validateClientMessage({ type: "receipt", receipt: { ...signed, payload: { ...payload, from: "1" } } }), null);
    assert.deepEqual(validateClientMessage({ type: "watch", userId: USER_A }), { type: "watch", userId: USER_A });
    assert.equal(validateClientMessage({ type: "watch", userId: USER_A, t: 1 }), null);

    assert.equal(isSnowflake(USER_A), true);
    assert.equal(isSnowflake("1234"), false);
    assert.equal(isSnowflake(123456789012345678), false);
});

test("server message validator accepts relay frames", () => {
    const limits = { ...DEFAULT_LIMITS };
    const hello = {
        type: "hello",
        v: PROTOCOL_VERSION,
        challenge: "C".repeat(43),
        serverVersion: "1.0.0",
        serverTime: 1_700_000_000_000,
        limits
    };
    assert.deepEqual(validateServerMessage(hello), hello);
    assert.equal(validateServerMessage({ ...hello, v: 2 }), null);
    assert.equal(validateServerMessage({ ...hello, limits: { ...limits, receiptBurst: 0 } }), null);

    assert.deepEqual(validateServerMessage({
        type: "error",
        code: "rate_limited",
        message: "slow down",
        fatal: false,
        retryAfterMs: 250
    }), {
        type: "error",
        code: "rate_limited",
        message: "slow down",
        fatal: false,
        retryAfterMs: 250
    });

    assert.equal(validateServerMessage({ type: "pong", t: 1, serverTime: 2 })?.type, "pong");
    assert.equal(validateServerMessage({ type: "pong", t: 1 }), null);
});

test("server URL validation enforces TLS and rejects credentials", () => {
    assert.deepEqual(normalizeServerUrl("wss://markread.example.com/ws"), { url: "wss://markread.example.com/ws" });
    assert.deepEqual(normalizeServerUrl("ws://localhost:8787"), { url: "ws://localhost:8787/" });
    assert.deepEqual(normalizeServerUrl("ws://127.0.0.1:8787"), { url: "ws://127.0.0.1:8787/" });

    assert.deepEqual(normalizeServerUrl("ws://example.com"), { error: "insecure_transport" });
    assert.deepEqual(normalizeServerUrl("https://example.com"), { error: "invalid_protocol" });
    assert.deepEqual(normalizeServerUrl("wss://user:pass@example.com"), { error: "credentials_not_allowed" });
    assert.deepEqual(normalizeServerUrl("wss://example.com/#fragment"), { error: "hash_not_allowed" });
    assert.deepEqual(normalizeServerUrl(""), { error: "not_configured" });
    assert.deepEqual(normalizeServerUrl("not a url"), { error: "invalid_url" });
});

test("backoff is bounded and jittered", () => {
    assert.equal(computeBackoffMs(0, () => 0), 500);
    assert.equal(computeBackoffMs(0, () => 1), 1_000);
    assert.equal(computeBackoffMs(3, () => 1), 8_000);
    assert.equal(computeBackoffMs(20, () => 1), 60_000);
});

test("message version uses the edited timestamp", () => {
    assert.equal(getMessageVersion({}), 0);
    assert.equal(getMessageVersion({ editedTimestamp: null }), 0);
    assert.equal(getMessageVersion({ editedTimestamp: new Date(1_700_000_000_000) }), 1_700_000_000_000);
    assert.equal(getMessageVersion({ editedTimestamp: "2023-11-14T22:13:20.000Z" }), 1_700_000_000_000);
    assert.equal(getMessageVersion({ editedTimestamp: new Date(Number.NaN) }), 0);
});

test("receipt records copy all identifying fields", async () => {
    const payload = makePayload();
    const record = receiptRecordFromPayload(payload, 42);
    assert.equal(record.receiptId, payload.receiptId);
    assert.equal(record.from, payload.from);
    assert.equal(record.to, payload.to);
    assert.equal(record.channelId, payload.channelId);
    assert.equal(record.messageId, payload.messageId);
    assert.equal(record.messageVersion, 0);
    assert.equal(record.readAt, payload.readAt);
    assert.equal(record.receivedAt, 42);
});

test("public key fingerprint is stable and formatted", async () => {
    const { publicKey } = await makeIdentity();
    const fingerprint = await fingerprintPublicKey(publicKey);
    assert.match(fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(await fingerprintPublicKey(publicKey), fingerprint);
    assert.notEqual(await fingerprintPublicKey((await makeIdentity()).publicKey), fingerprint);
});
