/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";
import { MessageStore, SelectedChannelStore, UserStore } from "@webpack/common";

import { getDmPeerId, isSupportedDm } from "./policy";

export function getCurrentUserId(): string | null {
    return UserStore.getCurrentUser()?.id ?? null;
}

export function getDmPeer(channel: Channel | null | undefined): { id: string; isBot: boolean; } | null {
    const peerId = getDmPeerId(channel);
    if (!peerId) return null;
    const user = UserStore.getUser(peerId);
    const raw = channel?.rawRecipients?.[0];
    return { id: peerId, isBot: user?.bot === true || raw?.bot === true };
}

export function isSupportedDmChannel(channel: Channel | null | undefined): boolean {
    if (!isSupportedDm(channel)) return false;
    return getDmPeer(channel)?.isBot === false;
}

/** Returns the live message record, or undefined if it was deleted. */
export function getLiveMessage(message: Pick<Message, "channel_id" | "id">): Message | undefined {
    return MessageStore.getMessage(message.channel_id, message.id) as Message | undefined;
}

export function isChannelSelected(channelId: string): boolean {
    return SelectedChannelStore.getChannelId() === channelId;
}

/**
 * A modal dialog covers the chat. Discord marks real modal dialogs with
 * `aria-modal="true"`; the check prevents confirmations for content that is
 * technically laid out behind an overlay but cannot be seen.
 */
export function hasBlockingModal(): boolean {
    return document.querySelector('[role="dialog"][aria-modal="true"]') != null;
}

export function isWindowActive(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
}
