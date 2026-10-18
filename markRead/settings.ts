/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { DEFAULT_DWELL_MS, MAX_DWELL_MS, MIN_DWELL_MS } from "./core/policy";
import { requestConnectionSync } from "./core/runtime";

export const settings = definePluginSettings({
    exchangeEnabled: {
        type: OptionType.BOOLEAN,
        description: "Connect to the MarkRead relay and exchange read confirmations. Off by default: nothing is transmitted until you enable this.",
        default: false,
        onChange: () => requestConnectionSync()
    },
    shareReadReceipts: {
        type: OptionType.BOOLEAN,
        description: "Send a confirmation when you actually see a message from a MarkRead user. Requires receipt exchange. Off by default.",
        default: false,
        onChange: () => requestConnectionSync()
    },
    serverUrl: {
        type: OptionType.STRING,
        description: "WebSocket URL of your relay, for example wss://markread.example.com/ws. Plain ws:// is only accepted for localhost.",
        placeholder: "wss://markread.example.com/ws",
        default: "",
        onChange: () => requestConnectionSync()
    },
    dwellMs: {
        type: OptionType.SLIDER,
        description: "How long a message must stay visible in a focused window before it is confirmed.",
        default: DEFAULT_DWELL_MS,
        markers: [MIN_DWELL_MS, 500, 1_000, 1_500, 2_000, 3_000, 5_000, MAX_DWELL_MS],
        stickToMarkers: true
    },
    showSentChecks: {
        type: OptionType.BOOLEAN,
        description: "Show a single tick on your sent messages before a read confirmation arrives.",
        default: true
    },
    indicatorSize: {
        type: OptionType.SLIDER,
        description: "Indicator size in pixels.",
        default: 14,
        markers: [12, 14, 16, 18, 20],
        stickToMarkers: true
    },
    readColor: {
        type: OptionType.SELECT,
        description: "Colour of a confirmed read.",
        options: [
            { label: "Discord accent", value: "brand", default: true },
            { label: "Green", value: "green" },
            { label: "Blue", value: "blue" }
        ]
    },
    showReadTime: {
        type: OptionType.BOOLEAN,
        description: "Show when the confirmation arrived in the tooltip (uses your local time).",
        default: false
    }
});
