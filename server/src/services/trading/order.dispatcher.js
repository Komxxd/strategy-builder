/**
 * IN-MEMORY TOKEN BUCKET ORDER DISPATCHER
 * ========================================
 * Solves the 3-7s delay caused by broker rate-limiting and gateway buffering.
 * 
 * Key Principles:
 * 1. Independent Channels:
 *    Worker 1, Worker 2, Worker 3, Worker 4 run on separate channels.
 *    Orders for different accounts execute fully in parallel (0ms cross-account delay).
 * 
 * 2. Intra-Account Micro-Pacing (35ms):
 *    Within the SAME account/worker, orders (Leg 1, Leg 2) are micro-paced by 35ms.
 *    This prevents Cloudflare / SmartAPI gateway burst throttling without noticeable delay.
 * 
 * 3. Non-Blocking Pump:
 *    The dispatcher does NOT wait for broker round-trip before dispatching the next queued leg!
 *    Leg 1 dispatches at t=0ms, Leg 2 dispatches at t=35ms, both fly over the wire immediately.
 */

class ChannelQueue {
    constructor(channelKey, options = {}) {
        this.channelKey = channelKey;
        this.minGapMs = options.minGapMs || 35; // 35ms spacing between legs on the same account
        this.maxTokens = options.maxTokens || 10; // max burst tokens
        this.refillRatePerSec = options.refillRatePerSec || 10; // 10 tokens per second
        this.tokens = this.maxTokens;
        this.lastRefillTime = Date.now();
        this.lastDispatchTime = 0;
        this.queue = [];
        this.isDraining = false;
    }

    refill() {
        const now = Date.now();
        const elapsedSec = (now - this.lastRefillTime) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSec * this.refillRatePerSec);
        this.lastRefillTime = now;
    }

    enqueue(taskFn, meta = {}) {
        return new Promise((resolve, reject) => {
            const queueItem = {
                taskFn,
                resolve,
                reject,
                enqueuedAt: Date.now(),
                meta
            };
            this.queue.push(queueItem);
            this.pump();
        });
    }

    async pump() {
        if (this.isDraining || this.queue.length === 0) return;
        this.isDraining = true;

        while (this.queue.length > 0) {
            this.refill();

            const now = Date.now();
            const timeSinceLastDispatch = now - this.lastDispatchTime;
            const waitTimeForGap = Math.max(0, this.minGapMs - timeSinceLastDispatch);

            // If we ran out of tokens, calculate time needed to earn 1 token
            let waitTimeForToken = 0;
            if (this.tokens < 1) {
                waitTimeForToken = Math.ceil(((1 - this.tokens) / this.refillRatePerSec) * 1000);
            }

            const totalWait = Math.max(waitTimeForGap, waitTimeForToken);
            if (totalWait > 0) {
                await new Promise((r) => setTimeout(r, totalWait));
            }

            const item = this.queue.shift();
            if (!item) break;

            this.tokens = Math.max(0, this.tokens - 1);
            this.lastDispatchTime = Date.now();

            const dispatchLatencyMs = this.lastDispatchTime - item.enqueuedAt;
            if (dispatchLatencyMs > 5) {
                console.log(`[OrderDispatcher][${this.channelKey}] Paced dispatch (waited ${dispatchLatencyMs}ms in queue). Remaining in queue: ${this.queue.length}`);
            }

            // CRITICAL: Fire task asynchronously without awaiting response round-trip!
            // This ensures the next order in the queue can be dispatched after 35ms
            // without waiting for Angel One's network response to return.
            try {
                const promiseOrResult = item.taskFn();
                if (promiseOrResult && typeof promiseOrResult.then === "function") {
                    promiseOrResult
                        .then(item.resolve)
                        .catch(item.reject);
                } else {
                    item.resolve(promiseOrResult);
                }
            } catch (err) {
                item.reject(err);
            }
        }

        this.isDraining = false;
    }
}

class OrderDispatcher {
    constructor() {
        this.channels = new Map(); // channelKey -> ChannelQueue
    }

    getChannel(channelKey) {
        if (!this.channels.has(channelKey)) {
            this.channels.set(channelKey, new ChannelQueue(channelKey));
        }
        return this.channels.get(channelKey);
    }

    /**
     * Dispatches an order or order modification task through the account's token bucket.
     * @param {string} targetKey - Worker ID or User Connection ID
     * @param {string} userId - User ID for logging/auditing
     * @param {Function} taskFn - The async function that actually sends the trade
     * @param {Object} meta - Optional metadata (order variety, symbol, etc.)
     * @returns {Promise<any>}
     */
    dispatchTrade(targetKey, userId, taskFn, meta = {}) {
        const channelKey = targetKey || userId || "default";
        const channel = this.getChannel(channelKey);
        return channel.enqueue(taskFn, { ...meta, userId });
    }
}

// Global singleton instance
const orderDispatcher = new OrderDispatcher();

module.exports = orderDispatcher;
