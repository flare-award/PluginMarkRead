/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast } from "@webpack/common";

import { HeaderIndicatorWrapper } from "./components/Indicator";
import { MessageAccessory } from "./components/MessageAccessory";
import { SettingsPanel } from "./components/SettingsPanel";
import { MarkReadConnection } from "./core/connection";
import {
    getCurrentUserId,
    getDmPeer,
    getLiveMessage,
    isSupportedDmChannel
} from "./core/discord";
import { getDeviceId, getIdentity } from "./core/identity";
import { flushPersistence, loadPersistence, stopPersistence } from "./core/persistence";
import { getMessageVersion, receiptRecordFromPayload } from "./core/receiptStore";
import { isActive, setActive, setConnection, setSyncHandler } from "./core/runtime";
import {
    connectionStateStore,
    optOutStore,
    peerStatusStore,
    pinnedPeers,
    receiptStore,
    sentLog
} from "./core/state";
import { LIMITS, type SignedReceipt } from "./protocol";
import { settings } from "./settings";
import managedStyle from "./styles.css?managed";

const logger = new Logger("MarkRead");

let pluginConnection: MarkReadConnection | undefined;
let connectionUserId: string | undefined;

function currentConfig() {
    return {
        enabled: settings.store.exchangeEnabled,
        serverUrl: settings.store.serverUrl
    };
}

function ensureConnection(): void {
    if (!isActive()) return;

    const userId = getCurrentUserId();
    if (!userId) return;

    const config = currentConfig();

    if (!config.enabled) {
        pluginConnection?.stop();
        pluginConnection = undefined;
        connectionUserId = undefined;
        setConnection(undefined);
        peerStatusStore.clear();
        connectionStateStore.set({ phase: "disabled", since: Date.now() });
        return;
    }

    if (pluginConnection && connectionUserId === userId) {
        pluginConnection.configure(config);
        return;
    }

    pluginConnection?.stop();

    const connection = new MarkReadConnection({
        userId,
        config,
        statusStore: connectionStateStore,
        peerStore: peerStatusStore,
        getIdentity,
        getDeviceId,
        logger,
        onReceipt: handleReceipt
    });

    pluginConnection = connection;
    connectionUserId = userId;
    setConnection(connection);
    connection.start();
}

function handleReceipt(signed: SignedReceipt, receivedAt: number): void {
    const currentUserId = getCurrentUserId();
    if (!currentUserId) return;

    const { payload } = signed;
    if (payload.to !== currentUserId || payload.from === currentUserId) return;

    const channel = ChannelStore.getChannel(payload.channelId);
    if (!channel || !isSupportedDmChannel(channel)) return;

    const peer = getDmPeer(channel);
    if (!peer || peer.id !== payload.from) return;

    // The message may still be in Discord's cache; if it is, make sure it is
    // ours and that the receipt refers to a version of it.
    const live = getLiveMessage({ channel_id: payload.channelId, id: payload.messageId });
    if (live) {
        if (live.author?.id !== currentUserId) return;
        const version = getMessageVersion(live);
        if (payload.messageVersion > version) return;
    }

    const pin = pinnedPeers.pin(payload.from, signed.publicKey);
    if (pin === "mismatch") {
        logger.warn("Rejected a receipt: the peer signing key changed since it was pinned", {
            peerId: payload.from
        });
        peerStatusStore.setError(payload.from, "peer key mismatch");
        return;
    }

    const changed = receiptStore.add(receiptRecordFromPayload(payload, receivedAt));
    if (receiptStore.size > LIMITS.maxReceipts) receiptStore.prune();

    if (changed) logger.info("Read confirmation received", { messageId: payload.messageId });
}

const channelContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel: Channel | undefined = props?.channel;
    if (!channel || !isSupportedDmChannel(channel)) return;

    const disabled = optOutStore.has(channel.id);
    const item = (
        <Menu.MenuItem
            id="vc-markread-toggle-dm"
            label={disabled ? "Enable MarkRead confirmations" : "Disable MarkRead confirmations"}
            action={() => {
                const nowDisabled = optOutStore.toggle(channel.id);
                showToast({
                    text: nowDisabled
                        ? "MarkRead confirmations disabled for this DM"
                        : "MarkRead confirmations enabled for this DM",
                    variant: "success"
                });
            }}
        />
    );

    const group = findGroupChildrenByChildId("close-dm", children)
        ?? findGroupChildrenByChildId("mute-channel", children);

    if (group) group.push(item);
    else children.push(item);
};

export default definePlugin({
    name: "MarkRead",
    description: "Cooperative read confirmations for 1:1 Discord DMs, relayed through your own server.",
    searchTerms: ["read receipt", "read", "checkmark", "ticks", "dm", "markread"],
    tags: ["Chat", "Privacy", "Utility"],
    authors: [{ name: "MarkRead contributors", id: 0n }],
    settings,
    settingsAboutComponent: SettingsPanel,
    managedStyle,
    dependencies: ["MessageAccessoriesAPI"],

    patches: [
        {
            // Message header component (cozy mode). Appends the indicator right
            // after the timestamp; same anchor as UserMessagesPronouns.
            find: "showCommunicationDisabledStyles",
            replacement: {
                match: /(?<=return\s*\(0,\i\.jsxs?\)\(.+?!\i&&)(\(0,\i\.jsxs?\)\(.+?\{.+?\}\))/,
                replace: "[$1, $self.HeaderIndicatorWrapper(arguments[0])]"
            }
        }
    ],

    contextMenus: {
        "channel-context": channelContextPatch,
        "gdm-context": channelContextPatch
    },

    renderMessageAccessory({ message, channel }) {
        return <MessageAccessory message={message} channel={channel} />;
    },

    HeaderIndicatorWrapper,

    flux: {
        CONNECTION_OPEN() {
            ensureConnection();
        },
        LOGOUT() {
            pluginConnection?.stop();
            pluginConnection = undefined;
            connectionUserId = undefined;
            setConnection(undefined);
            peerStatusStore.clear();
            connectionStateStore.clear();
            void flushPersistence();
        },
        MESSAGE_DELETE({ id }: { id: string; }) {
            receiptStore.removeMessages([id]);
            sentLog.removeMessages([id]);
        },
        MESSAGE_DELETE_BULK({ ids }: { ids: string[]; }) {
            if (!Array.isArray(ids)) return;
            receiptStore.removeMessages(ids);
            sentLog.removeMessages(ids);
        }
    },

    async start() {
        setActive(true);
        setSyncHandler(() => {
            if (isActive()) ensureConnection();
        });

        try {
            await loadPersistence();
        } catch (error) {
            logger.error("Could not load persisted state", error);
        }

        ensureConnection();
    },

    stop() {
        setActive(false);
        setSyncHandler(undefined);

        pluginConnection?.stop();
        pluginConnection = undefined;
        connectionUserId = undefined;
        setConnection(undefined);
        peerStatusStore.clear();
        connectionStateStore.clear();

        void flushPersistence()
            .catch(error => logger.error("Could not flush state", error))
            .finally(() => stopPersistence());
    }
});
