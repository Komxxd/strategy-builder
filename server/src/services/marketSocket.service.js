const { WebSocketV2 } = require("smartapi-javascript");

let socket = null;
let isConnected = false;
let io = null; // Frontend socket.io instance
let subscribedTokens = new Set(); // Track ["EXCH:TOKEN", ...]
let debugLogCount = 0;

// Reconnect state
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastConnectionParams = null; // Store params so we can reconnect without re-login
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3000; // 3s base, doubles each attempt up to ~90s

const EXCH_MAPPING = {
    "NSE": 1,
    "NFO": 2,
    "BSE": 3,
    "BFO": 4,
    "MCX": 5,
    "NCDEX": 7
};

const INVERSE_EXCH_MAPPING = {
    1: "NSE",
    2: "NFO",
    3: "BSE",
    4: "BFO",
    5: "MCX",
    7: "NCDEX"
};

function setIo(_io) {
    io = _io;
}

/**
 * Safely emit socket-specific status to frontend (WebSocket pill).
 * Kept separate from broker_status (Angel One session) so the UI
 * can show two independent pills.
 * @param {boolean} connected
 */
function emitBrokerStatus(connected) {
    if (io) io.emit("socket_status", { connected });
}

/**
 * Emits the Angel One API session status to all connected frontend clients.
 * Called by auth.service.js when a token expires or a logout happens,
 * so the "Angel One" pill correctly goes red without a page refresh.
 * @param {boolean} connected
 */
function emitApiStatus(connected) {
    if (io) io.emit("broker_status", { connected });
}

/**
 * Gets the raw WebSocket readyState from the SmartAPI SDK socket instance.
 *
 * The SDK doesn't expose a stable public API for readyState, so we need to
 * probe multiple possible internal property names. If the SDK updates and
 * renames the property, the fallback chain prevents the guard from silently
 * breaking and blocking all subscriptions forever.
 *
 * readyState values: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
 * We only want to send when state === 1 (OPEN).
 *
 * Fails OPEN (returns 1) if no property is found — meaning if the SDK
 * completely changes its structure, we'll attempt the send and rely on
 * the SDK's own error handling, rather than silently dropping all data.
 */
function getWsReadyState() {
    if (!socket) return 0;
    // Try known property names across SDK versions
    const ws = socket.ws ?? socket._ws ?? socket._socket ?? null;
    if (ws && typeof ws.readyState === 'number') return ws.readyState;
    // Fallback: if we can't inspect readyState, fail open (let it try)
    return 1;
}

/**
 * Subscribes to tokens on the WebSocket.
 * Guards against sending before the socket is fully OPEN (readyState === 1).
 * This is the root cause of the "WebSocket is not open: readyState 0" crash.
 * @param {string} exchange - e.g. "NFO", "NSE"
 * @param {string[]} tokens - List of tokens
 */
function subscribeTokens(exchange, tokens) {
    if (!socket || !isConnected || getWsReadyState() !== 1) return;

    const exchType = EXCH_MAPPING[exchange];
    if (!exchType) {
        console.error(`[MarketSocket] Unknown exchange for subscription: ${exchange}`);
        return;
    }

    const newTokens = tokens.filter(t => !subscribedTokens.has(`${exchange}:${t}`));
    if (newTokens.length === 0) return;

    // Angel One smart-api limit is ~50 per request. Batching into 30 for safety.
    const CHUNK_SIZE = 30;
    for (let i = 0; i < newTokens.length; i += CHUNK_SIZE) {
        const batch = newTokens.slice(i, i + CHUNK_SIZE);
        const request = {
            correlationId: `strategy_builder_sub_${Date.now()}_${i}`,
            action: 1, // 1 for Subscribe
            mode: 1,   // 1 for LTP
            exchangeType: exchType,
            tokens: batch
        };

        try {
            socket.fetchData(request);
            batch.forEach(t => subscribedTokens.add(`${exchange}:${t}`));
        } catch (err) {
            console.error(`[MarketSocket] Error sending subscription batch ${i}:`, err.message);
        }
    }
}

/**
 * Syncs subscriptions with a fresh map of required tokens.
 * Automatically unsubscribes from tokens no longer in the map.
 * @param {Object} tasks - { exchangeName: Set(tokens) }
 */
function syncSubscriptions(tasks) {
    // Guard: only sync if socket is fully OPEN
    if (!socket || !isConnected || getWsReadyState() !== 1) return;

    const currentSubscriptions = Array.from(subscribedTokens); // ["NSE:22", "BFO:842"]

    // 1. Unsubscribe from stale tokens
    const staleMap = {}; // { exchange: [tokens] }

    currentSubscriptions.forEach(sub => {
        const [exch, token] = sub.split(":");
        if (!tasks[exch] || !tasks[exch].has(token)) {
            if (!staleMap[exch]) staleMap[exch] = [];
            staleMap[exch].push(token);
        }
    });

    Object.keys(staleMap).forEach(exch => {
        const tokens = staleMap[exch];
        const exchType = EXCH_MAPPING[exch];
        if (!exchType) return;

        // Batching for unsubscriptions (same 50-token limit as subscriptions)
        const CHUNK_SIZE = 30;
        for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
            const batch = tokens.slice(i, i + CHUNK_SIZE);
            const request = {
                correlationId: `strategy_builder_unsub_${Date.now()}_${i}`,
                action: 0, // 0 for Unsubscribe
                mode: 1,   // 1 for LTP
                exchangeType: exchType,
                tokens: batch
            };

            try {
                socket.fetchData(request);
                batch.forEach(t => subscribedTokens.delete(`${exch}:${t}`));
            } catch (err) {
                console.error(`[MarketSocket] Unsubscribe error for batch ${i}:`, err.message);
            }
        }
    });

    // 2. Subscribe to new tokens (subscribeTokens already handles filtering)
    Object.keys(tasks).forEach(exch => {
        subscribeTokens(exch, Array.from(tasks[exch]));
    });
}

/**
 * Attempts to reconnect the WebSocket with exponential backoff.
 * Uses the last stored connection params so re-login is not required.
 *
 * IMPORTANT: Angel One JWT tokens expire every 24 hours. If the socket
 * drops overnight and auto-reconnect keeps failing, all retries will
 * eventually fail with an expired token. When MAX_RECONNECT_ATTEMPTS is
 * reached, we MUST clear lastConnectionParams so the stale token is never
 * reused. The user must manually re-login to get a fresh token.
 */
function scheduleReconnect() {
    if (!lastConnectionParams) {
        console.warn("[MarketSocket] No stored connection params — cannot auto-reconnect. Please login again.");
        emitBrokerStatus(false);
        emitApiStatus(false);
        return;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(
            "[MarketSocket] Max reconnect attempts reached. " +
            "The JWT token may have expired (tokens last 24 hours). " +
            "Clearing stored credentials — manual re-login required."
        );

        // Clear stale params so expired tokens are never reused on the next attempt
        lastConnectionParams = null;
        reconnectAttempts = 0;

        // Tell the frontend both pills should go red —
        // the session is effectively dead until the user re-logs in
        emitBrokerStatus(false);  // WebSocket pill → grey
        emitApiStatus(false);     // Angel One pill → red
        return;
    }

    // Clear any existing pending reconnect timer
    if (reconnectTimer) clearTimeout(reconnectTimer);

    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), 90000); // Cap at 90s
    reconnectAttempts++;

    console.log(`[MarketSocket] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    reconnectTimer = setTimeout(() => {
        // Clear stale token tracking — the new socket needs a fresh slate
        // so syncSubscriptions() re-subscribes everything correctly
        subscribedTokens.clear();

        const { params } = lastConnectionParams;
        // Don't pass 'onConnected' back here. We only want the initial 
        // initialization (initializeActiveStrategies) to run ONCE after 
        // the first login, not after every single network reconnect.
        initMarketSocket(params);
    }, delay);
}


/**
 * Attaches all event listeners to the socket after a successful connection.
 * Extracted into its own function so it can be called clean on every reconnect.
 * @param {string} clientCode - for logging
 * @param {Function} onConnected - callback on first successful connect
 */
function attachSocketListeners(clientCode, onConnected) {
    // ------- Tick Handler -------
    socket.on("tick", (tick) => {
        if (!tick) return;

        if (debugLogCount < 5) {
            debugLogCount++;
        }

        const ltpRaw = tick.last_traded_price || tick.lp;
        if (ltpRaw === undefined) return;

        const exchType = tick.exchange_type || tick.exchangeType || tick.e;
        const exchStr = INVERSE_EXCH_MAPPING[exchType];

        let token = tick.token || tick.tk;
        if (token && typeof token === "string") {
            token = token.replace(/"/g, "");
        }

        const ltp = parseFloat(ltpRaw) / 100;

        if (exchStr && token) {
            // Updated to use the modular state management
            const { updateLtp } = require("./trading/strategy.state");
            updateLtp(`${exchStr}_${token}`, ltp);

            if (io) {
                io.emit("ltp_update", { exchange: exchStr, token, ltp });
            }
        }
    });

    // ------- Subscription Response -------
    socket.on("response", () => {
        // Intentionally silent — logged during debugging only
    });

    // ------- Error Handler -------
    // NOTE: This event fires from the SmartAPI library internals.
    // The "WebSocket is not open: readyState 0" crash comes from their
    // heartbeat running before the socket is fully OPEN. We set isConnected
    // to false here so our readyState guards in subscribeTokens/syncSubscriptions
    // will NOT try to send any more data, preventing further crashes.
    socket.on("error", (err) => {
        console.error("[MarketSocket] WebSocket Error Event:", typeof err === "object" ? err.message || JSON.stringify(err) : err);
        isConnected = false;
        emitBrokerStatus(false);
        scheduleReconnect();
    });

    // ------- Close Handler -------
    // Triggers auto-reconnect instead of leaving the socket dead.
    socket.on("close", (code, reason) => {
        console.log(`[MarketSocket] WebSocket Closed. Code: ${code}, Reason: ${reason || "N/A"}`);
        isConnected = false;
        emitBrokerStatus(false);
        scheduleReconnect();
    });
}

/**
 * Initializes (or re-initializes) the AngelOne market WebSocket.
 * Stores connection params for use by the auto-reconnect mechanism.
 * @param {{ jwtToken, feedToken, clientCode, apiKey }} params
 * @param {Function} [onConnected] - Optional callback on successful connect
 */
function initMarketSocket(params, onConnected) {
    const { jwtToken, feedToken, clientCode, apiKey } = params;

    if (socket) {
        disconnectMarketSocket(false); // disconnect cleanly but don't reset reconnect state
    }

    if (!jwtToken || !feedToken) {
        throw new Error("jwtToken and feedToken are required to init market socket");
    }

    // Store params for auto-reconnect — we need these without a new login
    lastConnectionParams = { params, onConnected };

    socket = new WebSocketV2({
        jwttoken: jwtToken,
        feedtype: feedToken,
        apikey: apiKey || process.env.SMARTAPI_API_KEY,
        clientcode: clientCode || process.env.SMARTAPI_CLIENT_ID,
    });

    socket.connect().then(() => {
        isConnected = true;
        reconnectAttempts = 0; // Reset backoff counter on successful connect
        console.log(`[MarketSocket] Connected for client: ${clientCode}`);

        // Notify frontend that the broker is back online
        emitBrokerStatus(true);

        if (typeof onConnected === "function") onConnected();

        attachSocketListeners(clientCode, onConnected);

    }).catch(err => {
        console.error("[MarketSocket] WebSocket connection error:", err.message || err);
        isConnected = false;
        emitBrokerStatus(false);
        scheduleReconnect();
    });

    return socket;
}

/**
 * Manually disconnects the WebSocket.
 * @param {boolean} [resetReconnect=true] - Set to false to preserve reconnect state during an internal reconnect cycle
 */
function disconnectMarketSocket(resetReconnect = true) {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (resetReconnect) {
        reconnectAttempts = 0;
        lastConnectionParams = null;
    }

    if (socket) {
        try {
            if (socket.terminate) socket.terminate();
            else if (socket.close) socket.close();
        } catch (e) {
            // Ignore errors during cleanup
        }
        socket = null;
        isConnected = false;
        subscribedTokens.clear();
        console.log("[MarketSocket] Manually disconnected.");
    }

    emitBrokerStatus(false);
}

/**
 * Broadcasts an alert message to all connected frontend clients.
 * @param {string} message
 * @param {string} type - 'error' | 'success' | 'info'
 */
function sendAlert(message, type = "error") {
    if (io) io.emit("strategy_alert", { message, type });
}

/**
 * Broadcasts a strategy-specific log to connected clients.
 * @param {string} strategyId
 * @param {Object} log - { time, message, levelBody }
 */
function sendStrategyLog(strategyId, log) {
    if (io) io.emit("strategy_log", { strategyId, log });
}

module.exports = {
    initMarketSocket,
    setIo,
    subscribeTokens,
    syncSubscriptions,
    disconnectMarketSocket,
    sendAlert,
    sendStrategyLog,
    isSocketConnected: () => isConnected,
    emitApiStatus,
};
