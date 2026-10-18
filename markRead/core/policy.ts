/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Pure policy functions shared by the UI, the receipt service and the tests.
 * Nothing in this file touches Discord, the DOM or the network.
 */

/** Discord's 1:1 DM channel type. */
export const DM_CHANNEL_TYPE = 1;

export const MIN_DWELL_MS = 250;
export const MAX_DWELL_MS = 10_000;
export const DEFAULT_DWELL_MS = 1_500;

/** At least this much of a tall message must be on screen. */
export const DEFAULT_MIN_VISIBLE_PX = 96;

export interface DmChannelLike {
    type?: number;
    recipients?: readonly string[];
}

/** Returns the other participant of a 1:1 DM, or null for every other channel. */
export function getDmPeerId(channel: DmChannelLike | null | undefined): string | null {
    if (!channel) return null;
    if (channel.type !== DM_CHANNEL_TYPE) return null;
    if (!Array.isArray(channel.recipients) || channel.recipients.length !== 1) return null;
    return channel.recipients[0] ?? null;
}

export function isSupportedDm(channel: DmChannelLike | null | undefined): boolean {
    return getDmPeerId(channel) != null;
}

export interface ReceiptEligibility {
    currentUserId: string | null;
    messageAuthorId: string;
    peerId: string | null;
    peerIsBot: boolean;
    channelType: number;
    sharingEnabled: boolean;
    exchangeEnabled: boolean;
    channelOptOut: boolean;
    messageDeleted?: boolean;
}

/**
 * Whether this client is allowed to confirm that the local user saw an incoming
 * message. This never considers presence, delivery or "the channel is open":
 * only an actual visibility event can trigger a receipt (see visibility.ts).
 */
export function canSendReadReceipt(e: ReceiptEligibility): boolean {
    if (!e.currentUserId) return false;
    if (!e.sharingEnabled || !e.exchangeEnabled) return false;
    if (e.channelOptOut || e.messageDeleted) return false;
    if (e.peerIsBot || e.peerId == null) return false;
    if (e.channelType !== DM_CHANNEL_TYPE) return false;
    if (e.messageAuthorId !== e.peerId) return false;
    if (e.messageAuthorId === e.currentUserId) return false;
    return true;
}

export interface IndicatorEligibility {
    currentUserId: string | null;
    authorId: string;
    channelType: number;
    peerId: string | null;
    peerIsBot: boolean;
    deleted?: boolean;
}

/** Whether a sent/read indicator may be rendered for a local message. */
export function canShowSentIndicator(e: IndicatorEligibility): boolean {
    return !!e.currentUserId
        && !e.deleted
        && e.channelType === DM_CHANNEL_TYPE
        && e.peerId != null
        && !e.peerIsBot
        && e.authorId === e.currentUserId;
}

export interface ReceiptMatchInput {
    currentUserId: string | null;
    authorId: string;
    peerId: string | null;
    channelId: string;
    messageId: string;
    messageVersion: number;
    receipt: {
        from: string;
        to: string;
        channelId: string;
        messageId: string;
        messageVersion: number;
    };
}

/**
 * Final guard before a receipt is applied to a message. The signature proves
 * who sent it, this proves that it is about this exact message version.
 */
export function receiptMatchesMessage(input: ReceiptMatchInput): boolean {
    const { receipt } = input;
    return input.currentUserId != null
        && input.authorId === input.currentUserId
        && input.peerId != null
        && receipt.to === input.currentUserId
        && receipt.from === input.peerId
        && receipt.channelId === input.channelId
        && receipt.messageId === input.messageId
        && receipt.messageVersion === input.messageVersion;
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

export interface VisibilityState {
    now: number;
    documentVisible: boolean;
    windowFocused: boolean;
    blockingModalOpen: boolean;
    channelSelected: boolean;
    intersectionRatio: number;
    intersectionHeight: number;
    elementHeight: number;
    /** When the message first satisfied every condition, or null. */
    visibleSince: number | null;
    dwellMs: number;
    minVisiblePx?: number;
}

/** Focused, visible window without a blocking dialog, in the selected channel. */
export function isEnvironmentUsable(state: VisibilityState): boolean {
    return state.documentVisible
        && state.windowFocused
        && !state.blockingModalOpen
        && state.channelSelected;
}

export function isEnoughVisible(state: VisibilityState): boolean {
    if (!(state.intersectionRatio > 0)) return false;
    if (!(state.intersectionHeight > 0)) return false;
    if (!(state.elementHeight > 0)) return false;

    const required = Math.min(state.elementHeight, state.minVisiblePx ?? DEFAULT_MIN_VISIBLE_PX);
    return state.intersectionHeight >= required;
}

/** True only after the message stayed visible for the whole dwell time. */
export function shouldSendReceipt(state: VisibilityState): boolean {
    if (!isEnvironmentUsable(state) || !isEnoughVisible(state)) return false;
    if (state.visibleSince == null) return false;

    const dwell = Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, state.dwellMs));
    return state.now - state.visibleSince >= dwell;
}

/* -------------------------------------------------------------------------- */
/* Display state                                                               */
/* -------------------------------------------------------------------------- */

export type ReceiptDisplay =
    | { kind: "none"; reason: DisplayReason; }
    | { kind: "read"; readAt: number; receivedAt: number; from: string; stale: boolean; };

export type DisplayReason =
    | "no_peer"
    | "self"
    | "group_dm"
    | "not_dm"
    | "peer_is_bot"
    | "not_shared"
    | "no_receipt"
    | "peer_offline"
    | "peer_unregistered"
    | "server_unavailable";

export interface ReceiptInfo {
    messageVersion: number;
    readAt: number;
    receivedAt: number;
    from: string;
}

export interface DisplayInput {
    currentUserId: string | null;
    authorId: string;
    channelType: number;
    peerId: string | null;
    peerIsBot: boolean;
    messageVersion: number;
    receipt: ReceiptInfo | null;
    exchangeEnabled: boolean;
    peerOnline: boolean | undefined;
    peerRegistered: boolean | undefined;
    connectionOnline: boolean;
}

/**
 * Converts the raw state into what the indicator should show. A read state is
 * only ever produced from a stored, signature-verified receipt.
 */
export function getReceiptDisplay(input: DisplayInput): ReceiptDisplay {
    if (!input.currentUserId) return { kind: "none", reason: "self" };
    if (input.authorId !== input.currentUserId) return { kind: "none", reason: "self" };
    if (input.channelType !== DM_CHANNEL_TYPE) return { kind: "none", reason: input.channelType === 3 ? "group_dm" : "not_dm" };
    if (input.peerId == null) return { kind: "none", reason: "no_peer" };
    if (input.peerIsBot) return { kind: "none", reason: "peer_is_bot" };

    const { receipt } = input;
    if (receipt && receipt.from === input.peerId) {
        if (receipt.messageVersion === input.messageVersion) {
            return {
                kind: "read",
                readAt: receipt.readAt,
                receivedAt: receipt.receivedAt,
                from: receipt.from,
                stale: false
            };
        }

        if (receipt.messageVersion < input.messageVersion) {
            return {
                kind: "read",
                readAt: receipt.readAt,
                receivedAt: receipt.receivedAt,
                from: receipt.from,
                stale: true
            };
        }
    }

    if (!input.exchangeEnabled) return { kind: "none", reason: "not_shared" };
    if (!input.connectionOnline) return { kind: "none", reason: "server_unavailable" };
    if (input.peerRegistered === false) return { kind: "none", reason: "peer_unregistered" };
    if (input.peerOnline === false) return { kind: "none", reason: "peer_offline" };

    return { kind: "none", reason: "no_receipt" };
}
