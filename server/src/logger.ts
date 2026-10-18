/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RelayConfig } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/**
 * Minimal structured-ish logger. It intentionally logs only ids, codes and
 * counters; message contents are never available to the relay anyway.
 */
export function createLogger(level: RelayConfig["logLevel"]): Logger {
    const threshold = LEVELS[level];

    const write = (kind: keyof typeof LEVELS, message: string, args: unknown[]) => {
        if (LEVELS[kind] < threshold) return;
        const line = `[${new Date().toISOString()}] ${kind.toUpperCase()} ${message}`;
        const stream = kind === "warn" || kind === "error" ? process.stderr : process.stdout;
        if (args.length > 0) stream.write(`${line} ${args.map(formatArg).join(" ")}\n`);
        else stream.write(`${line}\n`);
    };

    return {
        debug: (message, ...args) => write("debug", message, args),
        info: (message, ...args) => write("info", message, args),
        warn: (message, ...args) => write("warn", message, args),
        error: (message, ...args) => write("error", message, args)
    };
}

function formatArg(value: unknown): string {
    if (value instanceof Error) return value.stack ?? value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
