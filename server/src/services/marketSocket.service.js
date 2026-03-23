const { WebSocketV2 } = require("smartapi-javascript");

let socket = null;
let isConnected = false;
let io = null; // Frontend socket.io instance
let subscribedTokens = new Set(); // Track ["EXCH:TOKEN", ...]
let debugLogCount = 0;

const EXCH_MAPPING = {
    "NSE": 1,
    "NFO": 2,
    "BSE": 3,
    "BFO": 4,
    "MCX": 5,
    "NCDEX": 7
};

function setIo(_io) {
    io = _io;
}

/**
 * Subscribes to tokens on the WebSocket
 * @param {string} exchange - e.g. "NFO", "NSE"
 * @param {string[]} tokens - List of tokens
 */
function subscribeTokens(exchange, tokens) {
    if (!socket || !isConnected) {
        console.warn("[MarketSocket] Cannot subscribe: Socket not connected.");
        return;
    }

    const exchType = EXCH_MAPPING[exchange];
    if (!exchType) {
        console.error(`[MarketSocket] Unknown exchange for subscription: ${exchange}`);
        return;
    }

    // Filter only new tokens we haven't subscribed to yet
    const newTokens = tokens.filter(t => !subscribedTokens.has(`${exchange}:${t}`));
    if (newTokens.length === 0) return;

    // console.log(`[MarketSocket] Subscribing to ${newTokens.length} new tokens on ${exchange}`);

    const request = {
        correlationId: "strategy_builder_sub",
        action: 1, // 1 for Subscribe
        mode: 1,   // 1 for LTP
        exchangeType: exchType,
        tokens: newTokens
    };

    try {
        socket.fetchData(request);
        // Add to our tracking set
        newTokens.forEach(t => subscribedTokens.add(`${exchange}:${t}`));
    } catch (err) {
        console.error("[MarketSocket] Error sending subscription request:", err.message);
    }
}

/**
 * Syncs subscriptions with a fresh map of required tokens.
 * Automatically unsubscribes from tokens no longer in the map.
 * @param {Object} tasks - { exchangeName: Set(tokens) }
 */
function syncSubscriptions(tasks) {
    if (!socket || !isConnected) return;

    const currentSubscriptions = Array.from(subscribedTokens); // ["NSE:22", "BFO:842"]

    // 1. Unsubscribe from stale tokens
    const exchangesInTasks = Object.keys(tasks);
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

        // console.log(`[MarketSocket] Unsubscribing from ${tokens.length} stale tokens on ${exch}`);
        const request = {
            correlationId: "strategy_builder_unsub",
            action: 0, // 0 for Unsubscribe (as per SmartAPI V2 docs)
            mode: 1,   // 1 for LTP
            exchangeType: exchType,
            tokens: tokens
        };

        try {
            socket.fetchData(request);
            tokens.forEach(t => subscribedTokens.delete(`${exch}:${t}`));
        } catch (err) {
            console.error("[MarketSocket] Unsubscribe error:", err.message);
        }
    });

    // 2. Subscribe to new tokens (subscribeTokens already handles filtering)
    Object.keys(tasks).forEach(exch => {
        subscribeTokens(exch, Array.from(tasks[exch]));
    });
}

const INVERSE_EXCH_MAPPING = {
    1: "NSE",
    2: "NFO",
    3: "BSE",
    4: "BFO",
    5: "MCX",
    7: "NCDEX"
};

function initMarketSocket({ jwtToken, feedToken, clientCode, apiKey }, onConnected) {
    if (socket) {
        disconnectMarketSocket();
    }

    if (!jwtToken || !feedToken) {
        throw new Error("jwtToken and feedToken are required to init market socket");
    }

    socket = new WebSocketV2({
        jwttoken: jwtToken,
        feedtype: feedToken,
        apikey: apiKey || process.env.SMARTAPI_API_KEY,
        clientcode: clientCode || process.env.SMARTAPI_CLIENT_ID,
    });

    socket.connect().then(() => {
        isConnected = true;
        console.log("Market WebSocket connected for client:", clientCode);
        if (typeof onConnected === 'function') onConnected();

        // Listen for ticks
        socket.on("tick", (tick) => {
            if (!tick) return;

            // Log full tick once to debug field names
            if (debugLogCount < 5) {
                // console.log("[MarketSocket] FULL TICK DEBUG:", JSON.stringify(tick));
                debugLogCount++;
            }

            const ltpRaw = tick.last_traded_price || tick.lp;
            if (ltpRaw === undefined) return;

            const exchType = tick.exchange_type || tick.exchangeType || tick.e; // Try standard and abbreviated field names
            const exchStr = INVERSE_EXCH_MAPPING[exchType];

            // Clean token (AngelOne sometimes sends it with escaped quotes like "\"842458\"")
            let token = tick.token || tick.tk;
            if (token && typeof token === 'string') {
                token = token.replace(/"/g, "");
            }

            // Scaled price (Paise to Rupees)
            const ltp = parseFloat(ltpRaw) / 100;

            // Log once in a while to confirm traffic without flooding
            // if (Math.random() < 0.05) {
            //     console.log(`[MarketSocket] Live Tick: ${exchStr}:${token} -> ${ltp}`);
            // }

            if (exchStr && token) {
                // 1. Update Global LTP Map in Strategy Service
                // Lazy require to avoid circular dependency
                const strategyService = require("./strategy.service");
                strategyService.updateLtp(`${exchStr}_${token}`, ltp);

                // 2. Broadcast to Frontend
                if (io) {
                    io.emit("ltp_update", {
                        exchange: exchStr,
                        token: token,
                        ltp: ltp
                    });
                }
            }
        });

        // SmartAPI WebSocket V2 sends a response after subscription
        socket.on("response", (res) => {
            // console.log("[MarketSocket] Subscription Response:", JSON.stringify(res));
        });

        socket.on("error", (err) => {
            console.error("[MarketSocket] WebSocket Error Event:", err);
            isConnected = false;
            if (io) io.emit("broker_status", { connected: false });
        });

        socket.on("close", () => {
            console.log("[MarketSocket] WebSocket Closed Event");
            isConnected = false;
            if (io) io.emit("broker_status", { connected: false });
        });

    }).catch(err => {
        console.error("Market WebSocket connection error:", err);
    });

    return socket;
}

function disconnectMarketSocket() {
    if (socket) {
        if (socket.terminate) socket.terminate();
        else if (socket.close) socket.close();
        socket = null;
        isConnected = false;
        subscribedTokens.clear();
        console.log("Market WebSocket disconnected.");
    }
    if (io) io.emit("broker_status", { connected: false });
}

/**
 * Broadcasts an alert message to all connected frontend clients.
 * @param {string} message 
 * @param {string} type - 'error' | 'success' | 'info'
 */
function sendAlert(message, type = "error") {
    if (io) {
        io.emit("strategy_alert", { message, type });
    }
}

/**
 * Broadcasts a strategy-specific log to connected clients.
 * @param {string} strategyId 
 * @param {Object} log - { time, message, levelBody }
 */
function sendStrategyLog(strategyId, log) {
    if (io) {
        io.emit("strategy_log", { strategyId, log });
    }
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
};
