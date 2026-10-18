/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Relay side of the MarkRead wire protocol (version 1).
 *
 * The client implementation lives in `markRead/protocol.ts`. Only the parts
 * that the relay needs are duplicated here so that the server can be deployed
 * as a standalone Node.js package. The canonical JSON serializer and the
 * signing input must stay byte-identical to the client.
 */

export const PROTOCOL_VERSION = 1 as const;
export const SERVER_VERSION = "1.0.0";
export const CLIENT_VERSION = "1.0.0";

export interface ReceiptPayload {
    v: 1;
    kind: "read-receipt";
    receiptId: string;
    from: string;
    to: string;
    channelId: string;
    messageId: string;
    messageVersion: number;
    readAt: number;
    sentAt: number;
}

export interface SignedReceipt {
    payload: ReceiptPayload;
    publicKey: string;
    signature: string;
}

export interface QueuedReceipt {
    receipt: SignedReceipt;
    receivedAt: number;
}

export interface AuthMessage {
    type: "auth";
    v: 1;
    userId: string;
    deviceId: string;
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

export interface ErrorMessage {
    type: "error";
    code: ServerErrorCode;
    message: string;
    fatal: boolean;
    retryAfterMs?: number;
}

export interface ServerLimits {
    maxFrameBytes: number;
    receiptBurst: number;
    receiptsPerMinute: number;
    watchPerMinute: number;
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

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(value);
}

export function base64UrlEncode(bytes: Uint8Array<ArrayBufferLike>): string {
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out += BASE64URL_ALPHABET[(n >> 18) & 63];
        out += BASE64URL_ALPHABET[(n >> 12) & 63];
        out += BASE64URL_ALPHABET[(n >> 6) & 63];
        out += BASE64URL_ALPHABET[n & 63];
    }

    if (i < bytes.length) {
        const remaining = bytes.length - i;
        const n = (bytes[i]! << 16) | (remaining === 2 ? bytes[i + 1]! << 8 : 0);
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
        const c0 = BASE64URL_ALPHABET.indexOf(padded[i]!);
        const c1 = BASE64URL_ALPHABET.indexOf(padded[i + 1]!);
        const c2 = padded[i + 2] === "=" ? -1 : BASE64URL_ALPHABET.indexOf(padded[i + 2]!);
        const c3 = padded[i + 3] === "=" ? -1 : BASE64URL_ALPHABET.indexOf(padded[i + 3]!);

        if (c0 < 0 || c1 < 0) throw new Error("Invalid base64url string");

        const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
        out.push((n >> 16) & 255);
        if (c2 >= 0) out.push((n >> 8) & 255);
        if (c3 >= 0) out.push(n & 255);
    }

    return new Uint8Array(out);
}

export function randomBase64Url(byteLength: number): string {
    return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

/* -------------------------------------------------------------------------- */
/* Canonical JSON                                                              */
/* -------------------------------------------------------------------------- */

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
            const entries: string[] = [];
            for (const key of Object.keys(record).sort()) {
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

export function authSigningInput(fields: { userId: string; deviceId: string; nonce: string; }): string {
    return `markread-auth-v${PROTOCOL_VERSION}\n${fields.userId}\n${fields.deviceId}\n${fields.nonce}`;
}

export function receiptSigningInput(payload: ReceiptPayload): string {
    return `markread-receipt-v${PROTOCOL_VERSION}\n${canonicalJson(payload)}`;
}

export async function verifyString(publicKey: string, input: string, signature: string): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey(
            "spki",
            base64UrlDecode(publicKey),
            ECDSA_PARAMS,
            false,
            ["verify"]
        );
        return await crypto.subtle.verify(
            ECDSA_SIGN_PARAMS,
            key,
            base64UrlDecode(signature),
            utf8Encode(input)
        );
    } catch {
        return false;
    }
}

export function verifyAuth(auth: AuthMessage): Promise<boolean> {
    return verifyString(
        auth.publicKey,
        authSigningInput({ userId: auth.userId, deviceId: auth.deviceId, nonce: auth.nonce }),
        auth.signature
    );
}

export function verifyReceipt(receipt: SignedReceipt): Promise<boolean> {
    return verifyString(
        receipt.publicKey,
        receiptSigningInput(receipt.payload),
        receipt.signature
    );
}

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

function isUuid(value: unknown): value is string {
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
