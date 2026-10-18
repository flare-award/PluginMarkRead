/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    canSendReadReceipt,
    canShowSentIndicator,
    DEFAULT_DWELL_MS,
    DEFAULT_MIN_VISIBLE_PX,
    DM_CHANNEL_TYPE,
    getDmPeerId,
    getReceiptDisplay,
    isEnoughVisible,
    isEnvironmentUsable,
    isSupportedDm,
    MAX_DWELL_MS,
    MIN_DWELL_MS,
    receiptMatchesMessage,
    shouldSendReceipt,
    type DisplayInput,
    type VisibilityState
} from "../markRead/core/policy";

const SELF = "123456789012345678";
const PEER = "987654321098765432";
const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";

test("only 1:1 DMs have a peer", () => {
    assert.equal(getDmPeerId({ type: 1, recipients: [PEER] }), PEER);
    assert.equal(getDmPeerId({ type: 1, recipients: [] }), null);
    assert.equal(getDmPeerId({ type: 1, recipients: [PEER, SELF] }), null);
    assert.equal(getDmPeerId({ type: 3, recipients: [PEER, SELF] }), null);
    assert.equal(getDmPeerId({ type: 0, recipients: [PEER] }), null);
    assert.equal(getDmPeerId(null), null);

    assert.equal(isSupportedDm({ type: 1, recipients: [PEER] }), true);
    assert.equal(isSupportedDm({ type: 3, recipients: [PEER, SELF] }), false);
    assert.equal(DM_CHANNEL_TYPE, 1);
});

test("receipts are only allowed for incoming messages from the DM peer", () => {
    const base = {
        currentUserId: SELF,
        messageAuthorId: PEER,
        peerId: PEER,
        peerIsBot: false,
        channelType: 1,
        sharingEnabled: true,
        exchangeEnabled: true,
        channelOptOut: false
    } as const;

    assert.equal(canSendReadReceipt(base), true);
    assert.equal(canSendReadReceipt({ ...base, messageAuthorId: SELF }), false, "own messages are never confirmed");
    assert.equal(canSendReadReceipt({ ...base, peerId: "888888888888888888" }), false);
    assert.equal(canSendReadReceipt({ ...base, peerIsBot: true }), false);
    assert.equal(canSendReadReceipt({ ...base, channelType: 3 }), false);
    assert.equal(canSendReadReceipt({ ...base, sharingEnabled: false }), false);
    assert.equal(canSendReadReceipt({ ...base, exchangeEnabled: false }), false);
    assert.equal(canSendReadReceipt({ ...base, channelOptOut: true }), false);
    assert.equal(canSendReadReceipt({ ...base, messageDeleted: true }), false);
    assert.equal(canSendReadReceipt({ ...base, currentUserId: null }), false);
});

test("sent indicators only render for our own DM messages", () => {
    const base = {
        currentUserId: SELF,
        authorId: SELF,
        channelType: 1,
        peerId: PEER,
        peerIsBot: false
    };

    assert.equal(canShowSentIndicator(base), true);
    assert.equal(canShowSentIndicator({ ...base, authorId: PEER }), false);
    assert.equal(canShowSentIndicator({ ...base, peerIsBot: true }), false);
    assert.equal(canShowSentIndicator({ ...base, channelType: 3 }), false);
    assert.equal(canShowSentIndicator({ ...base, currentUserId: null }), false);
});

test("a receipt only matches the exact message version", () => {
    const base = {
        currentUserId: SELF,
        authorId: SELF,
        peerId: PEER,
        channelId: CHANNEL,
        messageId: MESSAGE,
        messageVersion: 10,
        receipt: {
            from: PEER,
            to: SELF,
            channelId: CHANNEL,
            messageId: MESSAGE,
            messageVersion: 10
        }
    };

    assert.equal(receiptMatchesMessage(base), true);
    assert.equal(receiptMatchesMessage({ ...base, messageVersion: 11 }), false);
    assert.equal(receiptMatchesMessage({ ...base, messageId: "333333333333333333" }), false);
    assert.equal(receiptMatchesMessage({ ...base, channelId: "444444444444444444" }), false);
    assert.equal(receiptMatchesMessage({
        ...base,
        receipt: { ...base.receipt, from: "555555555555555555" }
    }), false);
    assert.equal(receiptMatchesMessage({ ...base, authorId: PEER }), false);
});

test("visibility requires a focused window, selected channel and no modal", () => {
    const base: VisibilityState = {
        now: 1_000,
        documentVisible: true,
        windowFocused: true,
        blockingModalOpen: false,
        channelSelected: true,
        intersectionRatio: 1,
        intersectionHeight: 100,
        elementHeight: 100,
        visibleSince: null,
        dwellMs: DEFAULT_DWELL_MS
    };

    assert.equal(isEnvironmentUsable(base), true);
    assert.equal(isEnvironmentUsable({ ...base, documentVisible: false }), false);
    assert.equal(isEnvironmentUsable({ ...base, windowFocused: false }), false);
    assert.equal(isEnvironmentUsable({ ...base, blockingModalOpen: true }), false);
    assert.equal(isEnvironmentUsable({ ...base, channelSelected: false }), false);
});

test("visibility requires enough of the message on screen", () => {
    const base: VisibilityState = {
        now: 1_000,
        documentVisible: true,
        windowFocused: true,
        blockingModalOpen: false,
        channelSelected: true,
        intersectionRatio: 0.02,
        intersectionHeight: 10,
        elementHeight: 1_000,
        visibleSince: null,
        dwellMs: DEFAULT_DWELL_MS
    };

    assert.equal(isEnoughVisible(base), false);
    assert.equal(isEnoughVisible({ ...base, intersectionHeight: DEFAULT_MIN_VISIBLE_PX }), true, "tall messages need a fixed minimum");

    const short = { ...base, elementHeight: 40, intersectionHeight: 20 };
    assert.equal(isEnoughVisible(short), false);
    assert.equal(isEnoughVisible({ ...short, intersectionHeight: 40, intersectionRatio: 1 }), true);

    assert.equal(isEnoughVisible({ ...base, intersectionRatio: 0 }), false);
    assert.equal(isEnoughVisible({ ...base, elementHeight: 0 }), false);
});

test("dwell time gates the receipt and clamps unsafe values", () => {
    const base: VisibilityState = {
        now: 1_000,
        documentVisible: true,
        windowFocused: true,
        blockingModalOpen: false,
        channelSelected: true,
        intersectionRatio: 1,
        intersectionHeight: 100,
        elementHeight: 100,
        visibleSince: 0,
        dwellMs: DEFAULT_DWELL_MS
    };

    assert.equal(shouldSendReceipt(base), false);
    assert.equal(shouldSendReceipt({ ...base, now: DEFAULT_DWELL_MS }), true);
    assert.equal(shouldSendReceipt({ ...base, now: DEFAULT_DWELL_MS, windowFocused: false }), false);
    assert.equal(shouldSendReceipt({ ...base, now: DEFAULT_DWELL_MS, visibleSince: null }), false);

    // A dwell below the minimum is raised to the minimum.
    assert.equal(shouldSendReceipt({ ...base, now: MIN_DWELL_MS - 1, dwellMs: 1 }), false);
    assert.equal(shouldSendReceipt({ ...base, now: MIN_DWELL_MS, dwellMs: 1 }), true);

    // A dwell above the maximum is capped.
    assert.equal(shouldSendReceipt({ ...base, now: MAX_DWELL_MS - 1, dwellMs: 999_999 }), false);
    assert.equal(shouldSendReceipt({ ...base, now: MAX_DWELL_MS, dwellMs: 999_999 }), true);
});

test("display state separates read from sent and explains missing data", () => {
    const base: DisplayInput = {
        currentUserId: SELF,
        authorId: SELF,
        channelType: 1,
        peerId: PEER,
        peerIsBot: false,
        messageVersion: 5,
        receipt: null,
        exchangeEnabled: true,
        peerOnline: true,
        peerRegistered: true,
        connectionOnline: true
    };

    assert.deepEqual(getReceiptDisplay(base), { kind: "none", reason: "no_receipt" });

    const received = { messageVersion: 5, readAt: 10, receivedAt: 20, from: PEER };
    assert.deepEqual(getReceiptDisplay({ ...base, receipt: received }), {
        kind: "read", readAt: 10, receivedAt: 20, from: PEER, stale: false
    });
    assert.deepEqual(getReceiptDisplay({ ...base, receipt: { ...received, messageVersion: 4 } }), {
        kind: "read", readAt: 10, receivedAt: 20, from: PEER, stale: true
    });
    assert.deepEqual(getReceiptDisplay({ ...base, receipt: { ...received, messageVersion: 6 } }), {
        kind: "none", reason: "no_receipt"
    });
    assert.deepEqual(getReceiptDisplay({ ...base, receipt: { ...received, from: "999999999999999999" } }), {
        kind: "none", reason: "no_receipt"
    });

    assert.deepEqual(getReceiptDisplay({ ...base, exchangeEnabled: false }), { kind: "none", reason: "not_shared" });
    assert.deepEqual(getReceiptDisplay({ ...base, connectionOnline: false }), { kind: "none", reason: "server_unavailable" });
    assert.deepEqual(getReceiptDisplay({ ...base, peerRegistered: false }), { kind: "none", reason: "peer_unregistered" });
    assert.deepEqual(getReceiptDisplay({ ...base, peerOnline: false }), { kind: "none", reason: "peer_offline" });
    assert.deepEqual(getReceiptDisplay({ ...base, peerIsBot: true }), { kind: "none", reason: "peer_is_bot" });
    assert.deepEqual(getReceiptDisplay({ ...base, channelType: 3 }), { kind: "none", reason: "group_dm" });
    assert.deepEqual(getReceiptDisplay({ ...base, authorId: PEER }), { kind: "none", reason: "self" });
    assert.deepEqual(getReceiptDisplay({ ...base, currentUserId: null }), { kind: "none", reason: "self" });
});
