/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Wire protocol shared by the MarkRead client plugin and the relay server.
 *
 * This file is intentionally free of any Vencord, Discord or Node.js imports so
 * that it can be unit tested and reused by the server. It only relies on
 * standards available in both browsers (Electron renderer) and Node.js 20+:
 * `crypto.subtle`, `TextEncoder`, `TextDecoder` and `Uint8Array`.
 *
 * All objects that are signed use a deterministic canonical JSON encoding.
 * Never reorder fields or change the signing prefixes without bumping
 * PROTOCOL_VERSION — old receipts would otherwise fail verification.
 */

export const PROTOCOL_VERSION = 1 as const;
export const CLIENT_VERSION = "1.0.0";

/** Hard upper bound for a single websocket frame. */
export const MAX_FRAME_BYTES = 16 * 1024;

/** Default server-side receipt rate limiting (per connection). */
export const DEFAULT_RECEIPT_BURST = 120;
export const DEFAULT_RECEIPTS_PER_MINUTE = 240;
export const DEFAULT_WATCH_PER_MINUTE = 60;

/** How much clock skew the server tolerates for `sentAt`. */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
/** A receipt may never be older than this on the wire (defensive bound). */
export const MAX_RECEIPT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type ServerLimits = {
    maxFrameBytes: number;
    receiptBurst: number;
    receiptsPerMinute: number;
    watchPerMinute: number;
};

export const DEFAULT_LIMITS: ServerLimits = {
    maxFrameBytes: MAX_FRAME_BYTES,
    receiptBurst: DEFAULT_RECEIPT_BURST,
    receiptsPerMinute: DEFAULT_RECEIPTS_PER_MINUTE,
    watchPerMinute: DEFAULT_WATCH_PER_MINUTE
};

/**
 * A single read confirmation.
 *
 * `messageVersion` is the Discord `editedTimestamp` in milliseconds (or 0 if
 * the message was never edited). It binds a confirmation to the exact content
 * version the recipient actually saw.
 */
export interface ReceiptPayload {
    v: 1;
    kind: "read-receipt";
    receiptId: string;
    /** Discord user id of the recipient that confirms the read. */
    from: string;
    /** Discord user id of the author that receives the confirmation. */
    to: string;
    channelId: string;
    messageId: string;
    messageVersion: number;
    /** When the recipient's client observed the message (recipient clock). */
    readAt: number;
    /** When the receipt was signed (recipient clock). */
    sentAt: number;
}

export interface SignedReceipt {
    payload: ReceiptPayload;
    /** base64url encoded SPKI (ECDSA P-256) public key of the recipient. */
    publicKey: string;
    /** base64url encoded raw ECDSA P-256 signature (r || s). */
    signature: string;
}

export interface AuthMessage {
    type: "auth";
    v: 1;
    userId: string;
    deviceId: string;
    /** Challenge from the server `hello` message. */
    nonce: string;
    publicKey: string;
    signature: string;
    clientVersion: string;
}

export type ClientMessage =
    | AuthMessage
    | { type: "receipt"; receipt: SignedReceipt; }
    | { type: "watch"; userId: string; }
    | { type: "unwatch"; userId: string; }
    | { type: "ping"; t: number; };

export interface HelloMessage {
    type: "hello";
    v: 1;
    challenge: string;
    serverVersion: string;
    serverTime: number;
    limits: ServerLimits;
}

export interface ReadyMessage {
    type: "ready";
    userId: string;
    sessionId: string;
    serverTime: number;
    /** Number of queued receipts that will be delivered right after `ready`. */
    pendingReceipts: number;
}

export type ServerErrorCode =
    | "bad_message"
    | "unsupported_protocol"
    | "auth_failed"
    | "auth_timeout"
    | "key_mismatch"
    | "too_many_connections"
    | "not_authenticated"
    | "rate_limited"
    | "invalid_receipt"
    | "receipt_rejected"
    | "payload_too_large"
    | "origin_not_allowed"
    | "server_shutting_down"
    | "internal_error";

export interface ErrorMessage {
    type: "error";
    code: ServerErrorCode;
    message: string;
    fatal: boolean;
    retryAfterMs?: number;
}

export interface PeerMessage {
    type: "peer";
    userId: string;
    registered: boolean;
    online: boolean;
    /** Short, human comparable fingerprint of the peer's pinned public key. */
    keyFingerprint?: string;
    watchedAt: number;
}

export interface ReceiptMessage {
    type: "receipt";
    receipt: SignedReceipt;
    /** Server receive time. Never signed; only used for sorting / pruning. */
    receivedAt: number;
}

export interface PongMessage {
    type: "pong";
    t: number;
    serverTime: number;
}

export type ServerMessage =
    | HelloMessage
    | ReadyMessage
    | ErrorMessage
    | PeerMessage
    | ReceiptMessage
    | PongMessage;

/* -------------------------------------------------------------------------- */
/* Encoding helpers                                                            */
/* -------------------------------------------------------------------------- */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(value);
}

export function utf8Decode(value: Uint8Array): string {
    return new TextDecoder().decode(value);
}

export function base64UrlEncode(bytes: Uint8Array<ArrayBufferLike>): string {
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += BASE64URL_ALPHABET[(n >> 18) & 63];
        out += BASE64URL_ALPHABET[(n >> 12) & 63];
        out += BASE64URL_ALPHABET[(n >> 6) & 63];
        out += BASE64URL_ALPHABET[n & 63];
    }

    if (i < bytes.length) {
        const remaining = bytes.length - i;
        const n = (bytes[i] << 16) | (remaining === 2 ? bytes[i + 1] << 8 : 0);
        out += BASE64URL_ALPHABET[(n >> 18) & 63];
        out += BASE64URL_ALPHABET[(n >> 12) & 63];
        if (remaining === 2) out += BASE64URL_ALPHABET[(n >> 6) & 63];
    }

    return out;
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
        throw new Error("Invalid base64url string");
    }
    if (value.length % 4 === 1) {
        throw new Error("Invalid base64url length");
    }

    const padding = (4 - (value.length % 4)) % 4;
    const padded = value + "=".repeat(padding);
    const out: number[] = [];

    for (let i = 0; i < padded.length; i += 4) {
        const c0 = BASE64URL_ALPHABET.indexOf(padded[i]);
        const c1 = BASE64URL_ALPHABET.indexOf(padded[i + 1]);
        const c2 = padded[i + 2] === "=" ? -1 : BASE64URL_ALPHABET.indexOf(padded[i + 2]);
        const c3 = padded[i + 3] === "=" ? -1 : BASE64URL_ALPHABET.indexOf(padded[i + 3]);

        const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
        out.push((n >> 16) & 255);
        if (c2 >= 0) out.push((n >> 8) & 255);
        if (c3 >= 0) out.push(n & 255);
    }

    return new Uint8Array(out);
}

export function randomBase64Url(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

/* -------------------------------------------------------------------------- */
/* Canonical JSON                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic JSON serialization: object keys sorted, no whitespace, no
 * floating point numbers, no undefined. This is what gets signed and verified.
 */
export function canonicalJson(value: unknown): string {
    if (value === null) return "null";

    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isSafeInteger(value)) {
                throw new Error("Canonical JSON only supports safe integers");
            }
            return String(value);
        case "object": {
            if (Array.isArray(value)) {
                return `[${value.map(canonicalJson).join(",")}]`;
            }

            const record = value as Record<string, unknown>;
            const keys = Object.keys(record).sort();
            const entries: string[] = [];
            for (const key of keys) {
                const entry = record[key];
                if (entry === undefined) continue;
                entries.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
            }
            return `{${entries.join(",")}}`;
        }
        default:
            throw new Error(`Unsupported value in canonical JSON: ${typeof value}`);
    }
}

/* -------------------------------------------------------------------------- */
/* Crypto                                                                      */
/* -------------------------------------------------------------------------- */

const ECDSA_PARAMS: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const ECDSA_SIGN_PARAMS: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

export function isCryptoAvailable(): boolean {
    return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

/**
 * Generates a new P-256 identity. The private key is non-extractable: once
 * stored in IndexedDB it cannot be exported from JavaScript.
 */
export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(ECDSA_PARAMS, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
    const spki = await crypto.subtle.exportKey("spki", publicKey);
    return base64UrlEncode(new Uint8Array(spki));
}

export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
    const spki = base64UrlDecode(publicKey);
    return crypto.subtle.importKey("spki", spki, ECDSA_PARAMS, false, ["verify"]);
}

export async function signString(privateKey: CryptoKey, input: string): Promise<string> {
    const signature = await crypto.subtle.sign(ECDSA_SIGN_PARAMS, privateKey, utf8Encode(input));
    return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyString(publicKey: string, input: string, signature: string): Promise<boolean> {
    try {
        const key = await importPublicKey(publicKey);
        return await crypto.subtle.verify(ECDSA_SIGN_PARAMS, key, base64UrlDecode(signature), utf8Encode(input));
    } catch {
        return false;
    }
}

export function authSigningInput(fields: { userId: string; deviceId: string; nonce: string; }): string {
    return `markread-auth-v${PROTOCOL_VERSION}\n${fields.userId}\n${fields.deviceId}\n${fields.nonce}`;
}

export function receiptSigningInput(payload: ReceiptPayload): string {
    return `markread-receipt-v${PROTOCOL_VERSION}\n${canonicalJson(payload)}`;
}

export async function signAuth(
    privateKey: CryptoKey,
    fields: { userId: string; deviceId: string; nonce: string; publicKey: string; }
): Promise<AuthMessage> {
    const signature = await signString(privateKey, authSigningInput(fields));
    return {
        type: "auth",
        v: PROTOCOL_VERSION,
        userId: fields.userId,
        deviceId: fields.deviceId,
        nonce: fields.nonce,
        publicKey: fields.publicKey,
        signature,
        clientVersion: CLIENT_VERSION
    };
}

export async function verifyAuth(auth: AuthMessage): Promise<boolean> {
    return verifyString(
        auth.publicKey,
        authSigningInput({ userId: auth.userId, deviceId: auth.deviceId, nonce: auth.nonce }),
        auth.signature
    );
}

export async function signReceiptPayload(
    privateKey: CryptoKey,
    publicKey: string,
    payload: ReceiptPayload
): Promise<SignedReceipt> {
    const signature = await signString(privateKey, receiptSigningInput(payload));
    return { payload, publicKey, signature };
}

export async function verifyReceipt(signed: SignedReceipt): Promise<boolean> {
    return verifyString(
        signed.publicKey,
        receiptSigningInput(signed.payload),
        signed.signature
    );
}

/** Short human comparable fingerprint of an SPKI public key. */
export async function fingerprintPublicKey(publicKey: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", base64UrlDecode(publicKey)));
    const hex = Array.from(digest.subarray(0, 8), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const SNOWFLAKE_RE = /^\d{16,21}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && SNOWFLAKE_RE.test(value);
}

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_RE.test(value);
}

function isBase64Url(value: unknown, minLength: number, maxLength: number): value is string {
    return typeof value === "string"
        && value.length >= minLength
        && value.length <= maxLength
        && BASE64URL_RE.test(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record);
    return actual.length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

const RECEIPT_KEYS = [
    "v", "kind", "receiptId", "from", "to", "channelId",
    "messageId", "messageVersion", "readAt", "sentAt"
] as const;

export function validateReceiptPayload(value: unknown): ReceiptPayload | null {
    if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return null;
    if (value.v !== PROTOCOL_VERSION || value.kind !== "read-receipt") return null;

    if (!isUuid(value.receiptId)) return null;
    if (!isSnowflake(value.from) || !isSnowflake(value.to)) return null;
    if (value.from === value.to) return null;
    if (!isSnowflake(value.channelId) || !isSnowflake(value.messageId)) return null;
    if (!isInt(value.messageVersion, 0, Number.MAX_SAFE_INTEGER)) return null;
    if (!isInt(value.readAt, 0, Number.MAX_SAFE_INTEGER)) return null;
    if (!isInt(value.sentAt, 0, Number.MAX_SAFE_INTEGER)) return null;

    return {
        v: PROTOCOL_VERSION,
        kind: "read-receipt",
        receiptId: value.receiptId,
        from: value.from,
        to: value.to,
        channelId: value.channelId,
        messageId: value.messageId,
        messageVersion: value.messageVersion,
        readAt: value.readAt,
        sentAt: value.sentAt
    };
}

export function validateSignedReceipt(value: unknown): SignedReceipt | null {
    if (!isRecord(value) || !hasExactKeys(value, ["payload", "publicKey", "signature"])) return null;

    const payload = validateReceiptPayload(value.payload);
    if (!payload) return null;
    if (!isBase64Url(value.publicKey, 80, 260)) return null;
    if (!isBase64Url(value.signature, 80, 100)) return null;

    return { payload, publicKey: value.publicKey, signature: value.signature };
}

const ERROR_CODES: ReadonlySet<string> = new Set<ServerErrorCode>([
    "bad_message", "unsupported_protocol", "auth_failed", "auth_timeout",
    "key_mismatch", "too_many_connections", "not_authenticated",
    "rate_limited", "invalid_receipt", "receipt_rejected", "payload_too_large",
    "origin_not_allowed", "server_shutting_down", "internal_error"
]);

function validateLimits(value: unknown): ServerLimits | null {
    if (!isRecord(value)) return null;
    const { maxFrameBytes, receiptBurst, receiptsPerMinute, watchPerMinute } = value;
    if (!isInt(maxFrameBytes, 1024, 1024 * 1024)) return null;
    if (!isInt(receiptBurst, 1, 100_000)) return null;
    if (!isInt(receiptsPerMinute, 1, 100_000)) return null;
    if (!isInt(watchPerMinute, 1, 100_000)) return null;
    return { maxFrameBytes, receiptBurst, receiptsPerMinute, watchPerMinute };
}

export function validateClientMessage(value: unknown): ClientMessage | null {
    if (!isRecord(value) || typeof value.type !== "string") return null;

    switch (value.type) {
        case "auth": {
            const keys = ["type", "v", "userId", "deviceId", "nonce", "publicKey", "signature", "clientVersion"] as const;
            if (!hasExactKeys(value, keys)) return null;
            if (value.v !== PROTOCOL_VERSION) return null;
            if (!isSnowflake(value.userId) || !isUuid(value.deviceId)) return null;
            if (!isBase64Url(value.nonce, 43, 43)) return null;
            if (!isBase64Url(value.publicKey, 80, 260)) return null;
            if (!isBase64Url(value.signature, 80, 100)) return null;
            if (typeof value.clientVersion !== "string" || value.clientVersion.length === 0 || value.clientVersion.length > 32) return null;

            return {
                type: "auth",
                v: PROTOCOL_VERSION,
                userId: value.userId,
                deviceId: value.deviceId,
                nonce: value.nonce,
                publicKey: value.publicKey,
                signature: value.signature,
                clientVersion: value.clientVersion
            };
        }
        case "receipt": {
            if (!hasExactKeys(value, ["type", "receipt"])) return null;
            const receipt = validateSignedReceipt(value.receipt);
            return receipt ? { type: "receipt", receipt } : null;
        }
        case "watch":
        case "unwatch": {
            if (!hasExactKeys(value, ["type", "userId"])) return null;
            if (!isSnowflake(value.userId)) return null;
            return { type: value.type, userId: value.userId };
        }
        case "ping": {
            if (!hasExactKeys(value, ["type", "t"])) return null;
            if (!isInt(value.t, 0, Number.MAX_SAFE_INTEGER)) return null;
            return { type: "ping", t: value.t };
        }
        default:
            return null;
    }
}

export function validateServerMessage(value: unknown): ServerMessage | null {
    if (!isRecord(value) || typeof value.type !== "string") return null;

    switch (value.type) {
        case "hello": {
            if (!hasExactKeys(value, ["type", "v", "challenge", "serverVersion", "serverTime", "limits"])) return null;
            if (value.v !== PROTOCOL_VERSION) return null;
            if (!isBase64Url(value.challenge, 43, 43)) return null;
            if (typeof value.serverVersion !== "string" || value.serverVersion.length > 64) return null;
            if (!isInt(value.serverTime, 0, Number.MAX_SAFE_INTEGER)) return null;
            const limits = validateLimits(value.limits);
            if (!limits) return null;
            return {
                type: "hello",
                v: PROTOCOL_VERSION,
                challenge: value.challenge,
                serverVersion: value.serverVersion,
                serverTime: value.serverTime,
                limits
            };
        }
        case "ready": {
            if (!hasExactKeys(value, ["type", "userId", "sessionId", "serverTime", "pendingReceipts"])) return null;
            if (!isSnowflake(value.userId) || !isUuid(value.sessionId)) return null;
            if (!isInt(value.serverTime, 0, Number.MAX_SAFE_INTEGER)) return null;
            if (!isInt(value.pendingReceipts, 0, 1_000_000)) return null;
            return {
                type: "ready",
                userId: value.userId,
                sessionId: value.sessionId,
                serverTime: value.serverTime,
                pendingReceipts: value.pendingReceipts
            };
        }
        case "error": {
            if (!isRecord(value) || typeof value.code !== "string" || !ERROR_CODES.has(value.code)) return null;
            if (typeof value.message !== "string" || value.message.length > 300) return null;
            if (typeof value.fatal !== "boolean") return null;
            if (value.retryAfterMs !== undefined && !isInt(value.retryAfterMs, 0, 86_400_000)) return null;
            const result: ErrorMessage = {
                type: "error",
                code: value.code as ServerErrorCode,
                message: value.message,
                fatal: value.fatal
            };
            if (value.retryAfterMs !== undefined) result.retryAfterMs = value.retryAfterMs as number;
            return result;
        }
        case "peer": {
            if (!hasExactKeys(value, ["type", "userId", "registered", "online", "watchedAt"])
                && !hasExactKeys(value, ["type", "userId", "registered", "online", "keyFingerprint", "watchedAt"])) return null;
            if (!isSnowflake(value.userId)) return null;
            if (typeof value.registered !== "boolean" || typeof value.online !== "boolean") return null;
            if (!isInt(value.watchedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
            if (value.keyFingerprint !== undefined && (typeof value.keyFingerprint !== "string" || value.keyFingerprint.length > 64)) return null;
            const result: PeerMessage = {
                type: "peer",
                userId: value.userId,
                registered: value.registered,
                online: value.online,
                watchedAt: value.watchedAt
            };
            if (value.keyFingerprint !== undefined) result.keyFingerprint = value.keyFingerprint as string;
            return result;
        }
        case "receipt": {
            if (!hasExactKeys(value, ["type", "receipt", "receivedAt"])) return null;
            const receipt = validateSignedReceipt(value.receipt);
            if (!receipt) return null;
            if (!isInt(value.receivedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
            return { type: "receipt", receipt, receivedAt: value.receivedAt };
        }
        case "pong": {
            if (!hasExactKeys(value, ["type", "t", "serverTime"])) return null;
            if (!isInt(value.t, 0, Number.MAX_SAFE_INTEGER)) return null;
            if (!isInt(value.serverTime, 0, Number.MAX_SAFE_INTEGER)) return null;
            return { type: "pong", t: value.t, serverTime: value.serverTime };
        }
        default:
            return null;
    }
}

/* -------------------------------------------------------------------------- */
/* Configuration helpers                                                       */
/* -------------------------------------------------------------------------- */

export type ServerUrlError =
    | "not_configured"
    | "invalid_url"
    | "credentials_not_allowed"
    | "hash_not_allowed"
    | "invalid_protocol"
    | "insecure_transport";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Only secure transports are accepted. Plain `ws://` is deliberately limited
 * to loopback addresses so that a misconfigured server never leaks metadata
 * over the network in clear text.
 */
export function normalizeServerUrl(input: string): { url: string; error?: undefined; } | { url?: undefined; error: ServerUrlError; } {
    const raw = input.trim();
    if (!raw) return { error: "not_configured" };

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return { error: "invalid_url" };
    }

    if (parsed.username || parsed.password) return { error: "credentials_not_allowed" };
    if (parsed.hash) return { error: "hash_not_allowed" };

    if (parsed.protocol === "wss:") {
        return { url: parsed.toString() };
    }

    if (parsed.protocol === "ws:") {
        if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { error: "insecure_transport" };
        return { url: parsed.toString() };
    }

    return { error: "invalid_protocol" };
}

/** Exponential backoff with jitter, capped at one minute. */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
    const exponent = Math.min(Math.max(attempt, 0), 6);
    const base = Math.min(60_000, 1_000 * 2 ** exponent);
    return Math.round(base * (0.5 + random() * 0.5));
}

/** Maximum number of characters kept in local receipt / dedupe stores. */
export const LIMITS = {
    maxReceipts: 5_000,
    maxSentLog: 2_000,
    maxPinnedPeers: 500,
    maxOptOutChannels: 500,
    maxPendingReceipts: 200,
    receiptTtlMs: 30 * 24 * 60 * 60 * 1000,
    sentLogTtlMs: 7 * 24 * 60 * 60 * 1000,
    receiptIdMemoryMs: 24 * 60 * 60 * 1000
} as const;

export function isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
    return isRecord(value)
        && typeof value.privateKey === "object" && value.privateKey !== null
        && typeof value.publicKey === "object" && value.publicKey !== null;
}
