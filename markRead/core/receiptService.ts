/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { Channel, Message } from "@vencord/discord-types";

import { type ReceiptPayload,signReceiptPayload } from "../protocol";
import { settings } from "../settings";
import {
    getCurrentUserId,
    getDmPeer,
    getLiveMessage,
    hasBlockingModal,
    isChannelSelected,
    isWindowActive
} from "./discord";
import { getIdentity } from "./identity";
import { canSendReadReceipt } from "./policy";
import { getMessageVersion } from "./receiptStore";
import { getConnection } from "./runtime";
import { optOutStore, receiptsInFlight, sentLog } from "./state";

const logger = new Logger("MarkRead");

/**
 * Creates and transmits one read confirmation for a message the local user has
 * actually seen.
 *
 * The visibility tracker already verified geometry and dwell time. Everything
 * is re-checked here immediately before signing, because loading the key and
 * signing are asynchronous and conditions (focus, selected channel, modal,
 * settings) can change in between.
 *
 * @returns true when a receipt was signed and handed to the connection.
 */
export async function trySendReadReceipt(message: Message, channel: Channel): Promise<boolean> {
    const connection = getConnection();
    if (!connection) return false;

    const currentUserId = getCurrentUserId();
    const peer = getDmPeer(channel);
    const live = getLiveMessage(message);
    if (!currentUserId || !peer || !live) return false;

    if (!canSendReadReceipt({
        currentUserId,
        messageAuthorId: live.author?.id ?? "",
        peerId: peer.id,
        peerIsBot: peer.isBot,
        channelType: channel.type,
        sharingEnabled: settings.store.shareReadReceipts,
        exchangeEnabled: settings.store.exchangeEnabled,
        channelOptOut: optOutStore.has(channel.id),
        messageDeleted: false
    })) return false;

    if (live.state !== "SENT") return false;

    const version = getMessageVersion(live);
    if (sentLog.has(live.id, version)) return false;

    const inFlightKey = `${live.id}:${version}`;
    if (receiptsInFlight.has(inFlightKey)) return false;

    if (!isWindowActive() || !isChannelSelected(channel.id) || hasBlockingModal()) return false;

    receiptsInFlight.add(inFlightKey);
    try {
        const identity = await getIdentity();

        // Conditions may have changed while the key was loaded from IndexedDB.
        if (sentLog.has(live.id, version)) return false;
        if (!isWindowActive() || !isChannelSelected(channel.id) || hasBlockingModal()) return false;
        if (optOutStore.has(channel.id)) return false;
        if (!settings.store.shareReadReceipts || !settings.store.exchangeEnabled) return false;

        const now = Date.now();
        const payload = {
            v: 1,
            kind: "read-receipt",
            receiptId: createUuid(),
            from: currentUserId,
            to: peer.id,
            channelId: channel.id,
            messageId: live.id,
            messageVersion: version,
            readAt: now,
            sentAt: now
        } satisfies ReceiptPayload;

        const signed = await signReceiptPayload(identity.privateKey, identity.publicKey, payload);

        if (!connection.sendReceipt(signed)) return false;

        sentLog.mark(live.id, {
            channelId: channel.id,
            messageVersion: version,
            sentAt: now
        });

        logger.info("Read confirmation queued", { messageId: live.id, channelId: channel.id });
        return true;
    } catch (error) {
        logger.error("Could not create a read confirmation", error);
        return false;
    } finally {
        receiptsInFlight.delete(inFlightKey);
    }
}

function createUuid(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

    // Extremely unlikely fallback for environments without randomUUID().
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
