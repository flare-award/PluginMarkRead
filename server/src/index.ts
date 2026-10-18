/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { RelayServer } from "./relay.js";
import { RelayState } from "./store.js";

async function main(): Promise<void> {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);

    const state = new RelayState(config.dataDir, {
        maxQueuedPerUser: config.maxQueuedPerUser,
        inboxTtlMs: config.inboxTtlMs,
        logger
    });

    await state.load();

    if (config.resetUser) {
        if (!config.dataDir) {
            logger.error("--reset-user requires --data-dir (or DATA_DIR) because the relay keeps its registry there.");
            process.exitCode = 1;
            return;
        }
        if (!/^\d{16,21}$/.test(config.resetUser)) {
            logger.error("--reset-user expects a Discord user id (16-21 digits).");
            process.exitCode = 1;
            return;
        }

        const removed = await state.resetUser(config.resetUser);
        logger.info(removed ? "User registration removed" : "No registration found for that user");
        state.stop();
        return;
    }

    const relay = new RelayServer(config, logger, state);
    const address = await relay.start();

    logger.info(`MarkRead relay ${address.host}:${address.port} is listening`);
    logger.info(`Protocol version 1, data directory: ${config.dataDir ?? "(memory only)"}`);
    if (!config.dataDir) {
        logger.warn("No --data-dir set: the key registry and queued receipts are lost on restart.");
    }
    logger.info("Terminate TLS in front of this process (nginx, Caddy, Traefik) and use a wss:// URL in the plugin.");

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`Received ${signal}, shutting down`);

        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref?.();

        try {
            await relay.stop();
            process.exit(0);
        } catch (error) {
            logger.error("Shutdown failed", error);
            process.exit(1);
        }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
