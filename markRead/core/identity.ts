/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import {
    exportPublicKey,
    fingerprintPublicKey,
    generateIdentityKeyPair,
    isCryptoKeyPair,
    isUuid
} from "../protocol";

const logger = new Logger("MarkRead");

const IDENTITY_KEY = "markread.identity.v1";
const IDENTITY_JWK_KEY = "markread.identity.jwk.v1";
const DEVICE_KEY = "markread.device.v1";

interface IdbIdentity {
    v: 1;
    pair: CryptoKeyPair;
    publicKey: string;
    createdAt: number;
}

interface JwkIdentity {
    v: 1;
    privateJwk: JsonWebKey;
    publicKey: string;
    createdAt: number;
}

export interface Identity {
    privateKey: CryptoKey;
    publicKey: string;
    createdAt: number;
    storage: "indexeddb" | "jwk-fallback";
}

let identityPromise: Promise<Identity> | undefined;
let cachedFingerprint: Promise<string> | undefined;
let deviceIdPromise: Promise<string> | undefined;

async function loadOrCreateIdentity(): Promise<Identity> {
    const stored = await DataStore.get<IdbIdentity>(IDENTITY_KEY);
    if (stored?.v === 1 && isCryptoKeyPair(stored.pair)) {
        try {
            const publicKey = typeof stored.publicKey === "string"
                ? stored.publicKey
                : await exportPublicKey(stored.pair.publicKey);
            return {
                privateKey: stored.pair.privateKey,
                publicKey,
                createdAt: stored.createdAt ?? Date.now(),
                storage: "indexeddb"
            };
        } catch (error) {
            logger.warn("Stored identity could not be read, generating a new one", error);
        }
    }

    // Fallback for environments where CryptoKey objects cannot be structured
    // cloned into IndexedDB. The private key is still stored locally only, but
    // it is extractable, so we prefer the primary path above.
    const fallback = await DataStore.get<JwkIdentity>(IDENTITY_JWK_KEY);
    if (fallback?.v === 1 && fallback.privateJwk && typeof fallback.publicKey === "string") {
        try {
            const privateKey = await crypto.subtle.importKey(
                "jwk",
                fallback.privateJwk,
                { name: "ECDSA", namedCurve: "P-256" },
                true,
                ["sign"]
            );
            return {
                privateKey,
                publicKey: fallback.publicKey,
                createdAt: fallback.createdAt ?? Date.now(),
                storage: "jwk-fallback"
            };
        } catch (error) {
            logger.warn("Stored JWK identity could not be read, generating a new one", error);
        }
    }

    const pair = await generateIdentityKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const createdAt = Date.now();

    try {
        await DataStore.set(IDENTITY_KEY, { v: 1, pair, publicKey, createdAt });
        return { privateKey: pair.privateKey, publicKey, createdAt, storage: "indexeddb" };
    } catch (error) {
        logger.warn("Could not store a non-extractable key, falling back to a local JWK", error);

        const extractable = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"]
        ) as CryptoKeyPair;
        const exportedPublicKey = await exportPublicKey(extractable.publicKey);
        const privateJwk = await crypto.subtle.exportKey("jwk", extractable.privateKey);
        await DataStore.set(IDENTITY_JWK_KEY, {
            v: 1,
            privateJwk,
            publicKey: exportedPublicKey,
            createdAt
        });
        return {
            privateKey: extractable.privateKey,
            publicKey: exportedPublicKey,
            createdAt,
            storage: "jwk-fallback"
        };
    }
}

export function getIdentity(): Promise<Identity> {
    identityPromise ??= loadOrCreateIdentity().catch(error => {
        identityPromise = undefined;
        throw error;
    });
    return identityPromise;
}

export async function getIdentityFingerprint(): Promise<string> {
    cachedFingerprint ??= getIdentity()
        .then(identity => fingerprintPublicKey(identity.publicKey))
        .catch(error => {
            cachedFingerprint = undefined;
            throw error;
        });
    return cachedFingerprint;
}

/** Creates a fresh identity. All previously sent receipts become invalid. */
export async function resetIdentity(): Promise<void> {
    identityPromise = undefined;
    cachedFingerprint = undefined;
    await Promise.all([
        DataStore.del(IDENTITY_KEY),
        DataStore.del(IDENTITY_JWK_KEY)
    ]);
}

export function getDeviceId(): Promise<string> {
    deviceIdPromise ??= (async () => {
        const stored = await DataStore.get<string>(DEVICE_KEY);
        if (isUuid(stored)) return stored;

        const id = crypto.randomUUID();
        await DataStore.set(DEVICE_KEY, id);
        return id;
    })().catch(error => {
        deviceIdPromise = undefined;
        throw error;
    });
    return deviceIdPromise;
}

export async function resetDeviceId(): Promise<void> {
    deviceIdPromise = undefined;
    await DataStore.del(DEVICE_KEY);
}
