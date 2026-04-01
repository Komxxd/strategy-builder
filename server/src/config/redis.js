const Redis = require("ioredis");

/**
 * Redis client configured for fail-fast behavior.
 *
 * Without these options, ioredis retries forever when Redis is unavailable.
 * This causes it to:
 *   1. Hold open connections in a retry loop
 *   2. Flood the error log with repeated ECONNREFUSED messages
 *   3. Queue up pending commands that never resolve, hanging market data requests
 *
 * With lazyConnect: the client won't try to connect until the first command —
 *   so if Redis isn't configured, the server starts cleanly without errors.
 * With maxRetriesPerRequest: 0 — each command fails immediately if Redis is down
 *   instead of retrying. This means Redis errors are thrown synchronously and
 *   caught by the try/catch in market.service.js, falling back to the live API.
 * With enableOfflineQueue: false — commands won't pile up in memory while Redis
 *   is reconnecting. They'll throw immediately, which is the safe behavior.
 */
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (times) => {
        // Retry up to 3 times with a fixed 2s delay, then give up
        // This means on startup it tries once, then caps out — no infinite loop
        if (times > 3) {
            console.warn("[Redis] Connection failed after 3 attempts. Running without cache.");
            return null; // Returning null stops retrying
        }
        return 2000; // Retry after 2 seconds
    }
});

redis.on("connect", () => console.log("[Redis] Connected ✅"));
redis.on("error", (err) => {
    // Only log once per error type to avoid flooding the error.log
    if (err.code === "ECONNREFUSED") {
        // Silently skip — retryStrategy already handles the reconnect cycle
        return;
    }
    console.error("[Redis] Error:", err.message);
});

module.exports = redis;
