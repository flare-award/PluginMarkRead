/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import type { Channel, Message } from "@vencord/discord-types";
import { React, Tooltip, UserStore } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

import { getDmPeer, isSupportedDmChannel } from "../core/discord";
import {
    canShowSentIndicator,
    type DisplayReason,
    getReceiptDisplay,
    type ReceiptDisplay
} from "../core/policy";
import { getMessageVersion } from "../core/receiptStore";
import { watchPeer } from "../core/runtime";
import type { PeerStatus } from "../core/stores";
import {
    useConnectionState,
    useCurrentUserId,
    useOptOut,
    usePeerStatus,
    useReceipt,
    useSettings
} from "./hooks";

const REASON_TEXT: Record<DisplayReason, string> = {
    no_peer: "This conversation has no single recipient.",
    self: "This is not your message.",
    group_dm: "Group DMs are not supported by MarkRead yet.",
    not_dm: "Read confirmations are only supported in 1:1 DMs.",
    peer_is_bot: "Bots cannot run MarkRead.",
    not_shared: "Receipt exchange is turned off in the MarkRead settings.",
    no_receipt: "No confirmation has arrived yet.",
    peer_offline: "The recipient is offline right now.",
    peer_unregistered: "The recipient is not registered on your relay.",
    server_unavailable: "Not connected to the MarkRead relay right now."
};

interface IndicatorViewProps {
    variant: "read" | "sent" | "stale";
    settings: ReturnType<typeof useSettings>;
    tooltip: ReactNode;
    onHover?: () => void;
}

function CheckIcon({ double, size }: { double: boolean; size: number; }) {
    return double ? (
        <svg
            className="vc-markread-icon"
            viewBox="0 0 22 16"
            width={Math.round(size * 1.35)}
            height={size}
            fill="none"
            aria-hidden="true"
        >
            <path d="M1.5 8.6 5.6 12.7 13.6 3.4" />
            <path d="M8.7 12.7 16.7 3.4" />
        </svg>
    ) : (
        <svg
            className="vc-markread-icon"
            viewBox="0 0 16 16"
            width={size}
            height={size}
            fill="none"
            aria-hidden="true"
        >
            <path d="M2 8.6 6.1 12.7 14 3.4" />
        </svg>
    );
}

function IndicatorView({ variant, settings, tooltip, onHover }: IndicatorViewProps) {
    const label = variant === "read"
        ? "Read by the recipient"
        : variant === "stale"
            ? "Read before the message was edited"
            : "Sent. No read confirmation yet";

    return (
        <Tooltip text={tooltip} position="top">
            {props => (
                <span
                    {...props}
                    className={[
                        "vc-markread-indicator",
                        `vc-markread-${variant}`,
                        variant === "read" ? `vc-markread-color-${settings.readColor}` : ""
                    ].filter(Boolean).join(" ")}
                    style={{ "--markread-size": `${settings.indicatorSize}px` } as CSSProperties}
                    role="img"
                    aria-label={label}
                    data-markread-status={variant}
                    onMouseEnter={() => {
                        props.onMouseEnter?.();
                        onHover?.();
                    }}
                    onFocus={() => {
                        props.onFocus?.();
                        onHover?.();
                    }}
                >
                    <CheckIcon double={variant === "read"} size={settings.indicatorSize} />
                </span>
            )}
        </Tooltip>
    );
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

interface IndicatorState {
    eligible: boolean;
    peerId: string | null;
    peerName: string | undefined;
    peerStatus: PeerStatus | undefined;
    display: ReceiptDisplay;
    editedTimestamp: number;
}

function useIndicatorState(message: Message, channel: Channel | undefined): IndicatorState {
    const settings = useSettings();
    const currentUserId = useCurrentUserId();
    const peer = getDmPeer(channel);
    const peerStatus = usePeerStatus(peer?.id ?? null);
    const receipt = useReceipt(message.id);
    const connection = useConnectionState();
    const optOut = useOptOut(channel?.id ?? "");

    const peerUser = peer ? UserStore.getUser(peer.id) : undefined;
    const version = getMessageVersion(message);
    const eligible = canShowSentIndicator({
        currentUserId,
        authorId: message.author?.id ?? "",
        channelType: channel?.type ?? 0,
        peerId: peer?.id ?? null,
        peerIsBot: peer?.isBot ?? false
    });

    const display = getReceiptDisplay({
        currentUserId,
        authorId: message.author?.id ?? "",
        channelType: channel?.type ?? 0,
        peerId: peer?.id ?? null,
        peerIsBot: peer?.isBot ?? false,
        messageVersion: version,
        receipt: receipt
            ? {
                messageVersion: receipt.messageVersion,
                readAt: receipt.readAt,
                receivedAt: receipt.receivedAt,
                from: receipt.from
            }
            : null,
        exchangeEnabled: settings.exchangeEnabled,
        peerOnline: peerStatus?.online,
        peerRegistered: peerStatus?.registered,
        connectionOnline: connection.phase === "online"
    });

    React.useEffect(() => {
        if (peer?.id && !optOut) watchPeer(peer.id);
    }, [peer?.id, optOut]);

    return {
        eligible,
        peerId: peer?.id ?? null,
        peerName: peerUser?.globalName || peerUser?.username,
        peerStatus,
        display,
        editedTimestamp: version
    };
}

function tooltipFor(state: IndicatorState, settings: ReturnType<typeof useSettings>, channel: Channel | undefined): ReactNode {
    const { display } = state;

    if (display.kind === "read") {
        return (
            <div className="vc-markread-tooltip">
                <strong>
                    {display.stale
                        ? "Read before the message was edited"
                        : state.peerName
                            ? `Read by ${state.peerName}`
                            : "Read by the recipient"}
                </strong>
                {display.stale
                    ? <span>The current, edited version has no confirmation yet.</span>
                    : <span>Confirmation verified with the recipient's key.</span>}
                {settings.showReadTime && (
                    <span>Arrived {new Date(display.receivedAt).toLocaleString()}</span>
                )}
            </div>
        );
    }

    const reason: DisplayReason = display.kind === "none" ? display.reason : "no_receipt";
    const details: string[] = [REASON_TEXT[reason]];

    if (reason === "no_receipt" && channel == null) details.push("The conversation is not loaded.");

    return (
        <div className="vc-markread-tooltip">
            <strong>Sent</strong>
            {details.map((line, index) => <span key={index}>{line}</span>)}
            <span className="vc-markread-tooltip-note">
                A missing confirmation does not mean the message is unread.
            </span>
        </div>
    );
}

/* -------------------------------------------------------------------------- */
/* Public components                                                          */
/* -------------------------------------------------------------------------- */

function MarkReadIndicator({ message, channel, className }: {
    message: Message;
    channel: Channel | undefined;
    className?: string;
}) {
    const settings = useSettings();
    const state = useIndicatorState(message, channel);

    if (!channel || !isSupportedDmChannel(channel)) return null;
    if (!state.eligible) return null;

    if (state.display.kind === "none") {
        const hidden: DisplayReason[] = ["no_peer", "self", "group_dm", "not_dm", "peer_is_bot"];
        if (hidden.includes(state.display.reason)) return null;
        if (!settings.showSentChecks) return null;

        return (
            <span className={["vc-markread-slot", className].filter(Boolean).join(" ")}>
                <IndicatorView
                    variant="sent"
                    settings={settings}
                    tooltip={tooltipFor(state, settings, channel)}
                />
            </span>
        );
    }

    return (
        <span className={["vc-markread-slot", className].filter(Boolean).join(" ")}>
            <IndicatorView
                variant={state.display.stale ? "stale" : "read"}
                settings={settings}
                tooltip={tooltipFor(state, settings, channel)}
            />
        </span>
    );
}

/**
 * Injected after the timestamp by a code patch (cozy mode). The wrapper always
 * renders, so CSS can tell whether this message has a visible header.
 */
export const HeaderIndicatorWrapper = ErrorBoundary.wrap(({ message, channel }: {
    message: Message;
    channel: Channel;
}) => (
    <span className="vc-markread-header-slot">
        <MarkReadIndicator message={message} channel={channel} />
    </span>
), { noop: true });

/**
 * Accessories API entry point used for grouped messages, which Discord renders
 * without a header and therefore without a timestamp.
 */
export const GroupedMessageIndicator = ErrorBoundary.wrap(({ message, channel }: {
    message: Message;
    channel: Channel;
}) => (
    <span className="vc-markread-grouped-slot">
        <MarkReadIndicator message={message} channel={channel} />
    </span>
), { noop: true });
