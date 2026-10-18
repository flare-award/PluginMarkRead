/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 MarkRead contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ConsumeResult {
    ok: boolean;
    retryAfterMs: number;
}

/**
 * Classic token bucket. `capacity` is the burst size, `refillPerMs` the steady
 * refill rate. Time is injected so the tests do not have to sleep.
 */
export class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly capacity: number,
        private readonly refillPerMs: number,
        now = Date.now()
    ) {
        this.tokens = capacity;
        this.lastRefill = now;
    }

    tryConsume(amount = 1, now = Date.now()): ConsumeResult {
        this.refill(now);

        if (this.tokens >= amount) {
            this.tokens -= amount;
            return { ok: true, retryAfterMs: 0 };
        }

        const missing = amount - this.tokens;
        return {
            ok: false,
            retryAfterMs: Math.max(1, Math.ceil(missing / this.refillPerMs))
        };
    }

    private refill(now: number): void {
        if (now <= this.lastRefill) return;
        const elapsed = now - this.lastRefill;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
        this.lastRefill = now;
    }
}
