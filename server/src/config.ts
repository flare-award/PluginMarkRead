/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseArgs } from "node:util";

export interface RelayConfig {
    host: string;
    port: number;
    /** Empty array means: accept every Origin header (WebSocket clients are authenticated anyway). */
    allowedOrigins: string[];
    /** Absolute path of the directory used to persist the key registry and queued receipts. */
    dataDir?: string;
    maxConnectionsPerUser: number;
    maxConnectionsTotal: number;
    authTimeoutMs: number;
    idleTimeoutMs: number;
    maxFrameBytes: number;
    receiptBurst: number;
    receiptsPerMinute: number;
    watchBurst: number;
    watchesPerMinute: number;
    /** How long a receipt may stay queued for an offline recipient. */
    inboxTtlMs: number;
    maxQueuedPerUser: number;
    logLevel: "debug" | "info" | "warn" | "error" | "silent";
    /** Administration command: forget a user's key and queued receipts, then exit. */
    resetUser?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULTS = {
    host: "0.0.0.0",
    port: 8787,
    maxConnectionsPerUser: 5,
    maxConnectionsTotal: 10_000,
    authTimeoutMs: 10_000,
    idleTimeoutMs: 90_000,
    maxFrameBytes: 16 * 1024,
    receiptBurst: 120,
    receiptsPerMinute: 240,
    watchBurst: 60,
    watchesPerMinute: 60,
    inboxTtlMs: 7 * DAY,
    maxQueuedPerUser: 200,
    logLevel: "info" as const
};

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function stringFromEnv(name: string, fallback: string): string {
    const raw = process.env[name];
    return raw == null || raw === "" ? fallback : raw;
}

export function loadConfig(argv = process.argv.slice(2), env = process.env): RelayConfig {
    const { values } = parseArgs({
        args: argv,
        options: {
            host: { type: "string" },
            port: { type: "string" },
            "data-dir": { type: "string" },
            "log-level": { type: "string" },
            "allowed-origins": { type: "string" },
            "reset-user": { type: "string" },
            help: { type: "boolean", short: "h" }
        },
        allowPositionals: false
    });

    if (values.help) {
        console.log([
            "MarkRead relay",
            "",
            "Usage: markread-relay [options]",
            "",
            "  --host <address>          Bind address (default 0.0.0.0)",
            "  --port <number>           TCP port (default 8787)",
            "  --data-dir <path>         Persist the key registry and offline receipts",
            "  --allowed-origins <list>  Comma separated Origin allowlist",
            "  --log-level <level>       debug | info | warn | error | silent",
            "  --reset-user <id>          Forget a user key and queued receipts, then exit",
            "",
            "Every option can also be set through environment variables:",
            "  HOST, PORT, DATA_DIR, ALLOWED_ORIGINS, LOG_LEVEL,",
            "  MAX_CONNECTIONS_PER_USER, MAX_CONNECTIONS_TOTAL, AUTH_TIMEOUT_MS,",
            "  IDLE_TIMEOUT_MS, MAX_FRAME_BYTES, RECEIPT_BURST, RECEIPTS_PER_MINUTE,",
            "  WATCH_BURST, WATCHES_PER_MINUTE, INBOX_TTL_HOURS, MAX_QUEUED_PER_USER"
        ].join("\n"));
        process.exit(0);
    }

    const logLevel = (values["log-level"] ?? env.LOG_LEVEL ?? DEFAULTS.logLevel) as RelayConfig["logLevel"];
    if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
        throw new Error("LOG_LEVEL must be one of debug, info, warn, error, silent");
    }

    const allowedOrigins = (values["allowed-origins"] ?? env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean);

    const dataDir = values["data-dir"] ?? env.DATA_DIR;

    return {
        host: values.host ?? stringFromEnv("HOST", DEFAULTS.host),
        port: Number(values.port ?? stringFromEnv("PORT", String(DEFAULTS.port))),
        allowedOrigins,
        dataDir: dataDir === "" ? undefined : dataDir,
        maxConnectionsPerUser: intFromEnv("MAX_CONNECTIONS_PER_USER", DEFAULTS.maxConnectionsPerUser, 1, 100),
        maxConnectionsTotal: intFromEnv("MAX_CONNECTIONS_TOTAL", DEFAULTS.maxConnectionsTotal, 1, 1_000_000),
        authTimeoutMs: intFromEnv("AUTH_TIMEOUT_MS", DEFAULTS.authTimeoutMs, 1_000, 120_000),
        idleTimeoutMs: intFromEnv("IDLE_TIMEOUT_MS", DEFAULTS.idleTimeoutMs, 10_000, 3_600_000),
        maxFrameBytes: intFromEnv("MAX_FRAME_BYTES", DEFAULTS.maxFrameBytes, 1_024, 1024 * 1024),
        receiptBurst: intFromEnv("RECEIPT_BURST", DEFAULTS.receiptBurst, 1, 100_000),
        receiptsPerMinute: intFromEnv("RECEIPTS_PER_MINUTE", DEFAULTS.receiptsPerMinute, 1, 100_000),
        watchBurst: intFromEnv("WATCH_BURST", DEFAULTS.watchBurst, 1, 100_000),
        watchesPerMinute: intFromEnv("WATCHES_PER_MINUTE", DEFAULTS.watchesPerMinute, 1, 100_000),
        inboxTtlMs: intFromEnv("INBOX_TTL_HOURS", DEFAULTS.inboxTtlMs / HOUR, 1, 24 * 30) * HOUR,
        maxQueuedPerUser: intFromEnv("MAX_QUEUED_PER_USER", DEFAULTS.maxQueuedPerUser, 1, 10_000),
        logLevel,
        ...(values["reset-user"] ? { resetUser: values["reset-user"] } : {})
    };
}
