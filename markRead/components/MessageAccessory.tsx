/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, React } from "@webpack/common";

import {
    getDmPeer,
    hasBlockingModal,
    isChannelSelected,
    isSupportedDmChannel
} from "../core/discord";
import {
    DEFAULT_MIN_VISIBLE_PX,
    isEnoughVisible,
    isEnvironmentUsable,
    shouldSendReceipt,
    type VisibilityState
} from "../core/policy";
import { trySendReadReceipt } from "../core/receiptService";
import { getMessageVersion } from "../core/receiptStore";
import { sentLog } from "../core/state";
import { useConnectionState, useCurrentUserId, useOptOut, useSettings } from "./hooks";
import { GroupedMessageIndicator } from "./Indicator";

/** Environment changes are re-checked at this rate while a dwell is running. */
const POLL_INTERVAL_MS = 400;
const RETRY_AFTER_FAILURE_MS = 5_000;

/**
 * Accessories API entry point.
 *
 * - renders the grouped-message indicator (grouped messages have no header and
 *   therefore no timestamp);
 * - mounts the visibility tracker for incoming messages, the only source of
 *   read confirmations.
 */
export function MessageAccessory({ message, channel: channelProp }: { message: Message; channel?: Channel; }) {
    const currentUserId = useCurrentUserId();

    if (!message) return null;

    const channel = channelProp ?? ChannelStore.getChannel(message.channel_id);
    if (!channel || !isSupportedDmChannel(channel)) return null;

    const peer = getDmPeer(channel);
    if (!peer) return null;

    const own = currentUserId != null && message.author?.id === currentUserId;
    const incomingFromPeer = message.author?.id === peer.id;

    return (
        <>
            {own && <GroupedMessageIndicator message={message} channel={channel} />}
            {incomingFromPeer && <VisibilityAnchor message={message} channel={channel} />}
        </>
    );
}

function VisibilityAnchor({ message, channel }: { message: Message; channel: Channel; }) {
    const hostRef = React.useRef<HTMLSpanElement>(null);
    const settings = useSettings();
    const connection = useConnectionState();
    const optOut = useOptOut(channel.id);
    const version = getMessageVersion(message);
    const authorId = message.author?.id;

    const enabled = settings.exchangeEnabled
        && settings.shareReadReceipts
        && !optOut
        && authorId != null
        && authorId === getDmPeer(channel)?.id;

    React.useEffect(() => {
        if (!enabled) return;

        const host = hostRef.current;
        if (!host) return;

        const article = host.closest('[role="article"]') as HTMLElement | null;
        if (!article) return;

        const { dwellMs } = settings;
        let visibleSince: number | null = null;
        let pollTimer: number | undefined;
        let retryTimer: number | undefined;
        let retryAt = 0;
        let lastEntry: IntersectionObserverEntry | undefined;
        let disposed = false;
        let completed = false;
        let generation = 0;

        function stopPolling() {
            if (pollTimer !== undefined) {
                clearInterval(pollTimer);
                pollTimer = undefined;
            }
        }

        function startPolling() {
            if (pollTimer !== undefined) return;
            pollTimer = window.setInterval(evaluate, POLL_INTERVAL_MS);
        }

        function resetDwell() {
            visibleSince = null;
            stopPolling();
        }

        function buildSample(now: number): VisibilityState {
            const entry = lastEntry;
            return {
                now,
                documentVisible: document.visibilityState === "visible",
                windowFocused: document.hasFocus(),
                blockingModalOpen: hasBlockingModal(),
                channelSelected: isChannelSelected(channel.id),
                intersectionRatio: entry?.intersectionRatio ?? 0,
                intersectionHeight: entry?.intersectionRect.height ?? 0,
                elementHeight: entry?.boundingClientRect.height ?? 0,
                visibleSince,
                dwellMs,
                minVisiblePx: DEFAULT_MIN_VISIBLE_PX
            };
        }

        function evaluate() {
            if (disposed || completed) return;

            const now = Date.now();
            if (retryAt !== 0) {
                if (now < retryAt) return;
                retryAt = 0;
            }

            const sample = buildSample(now);

            if (!isEnvironmentUsable(sample) || !isEnoughVisible(sample)) {
                resetDwell();
                return;
            }

            if (visibleSince == null) {
                visibleSince = now;
                startPolling();
                return;
            }

            if (!shouldSendReceipt(sample)) return;

            resetDwell();
            const attempt = ++generation;

            void trySendReadReceipt(message, channel).then(sent => {
                if (disposed || attempt !== generation) return;

                if (sent || sentLog.has(message.id, version)) {
                    completed = true;
                    return;
                }

                // The relay is unavailable, the user disabled sharing in the
                // meantime, or the message is gone. Retry after a pause; the
                // service itself re-checks every condition.
                retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
                if (retryTimer !== undefined) clearTimeout(retryTimer);
                retryTimer = window.setTimeout(() => {
                    retryTimer = undefined;
                    evaluate();
                }, RETRY_AFTER_FAILURE_MS);
            });
        }

        function evaluateSoon() {
            window.setTimeout(() => {
                if (!disposed) evaluate();
            }, 0);
        }

        const observer = new IntersectionObserver(entries => {
            const entry = entries[entries.length - 1];
            if (entry) lastEntry = entry;
            evaluate();
        }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

        observer.observe(article);
        document.addEventListener("visibilitychange", evaluateSoon);
        window.addEventListener("focus", evaluateSoon);
        window.addEventListener("blur", evaluateSoon);

        evaluate();

        return () => {
            disposed = true;
            completed = true;
            observer.disconnect();
            stopPolling();
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            document.removeEventListener("visibilitychange", evaluateSoon);
            window.removeEventListener("focus", evaluateSoon);
            window.removeEventListener("blur", evaluateSoon);
        };
    }, [message.id, version, channel.id, enabled, settings.dwellMs, connection.phase]);

    return <span ref={hostRef} className="vc-markread-anchor" aria-hidden="true" />;
}
