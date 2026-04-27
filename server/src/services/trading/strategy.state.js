const prisma = require("../../config/prisma");
const marketService = require("../market.service");
const marketSocketService = require("../marketSocket.service");
const { getISTFullDate } = require("./strategy.time");
let activeStrategies = new Map();
let globalLtpMap = {};

function updateLtp(key, price) {
    globalLtpMap[key] = price;
}

let isFetchingGlobalLtp = false;
let pendingDbUpdates = new Map();
let isWritingToDb = false;

async function runGlobalDbWriter() {
    if (isWritingToDb || pendingDbUpdates.size === 0) return;
    isWritingToDb = true;

    const updates = Array.from(pendingDbUpdates.entries());
    pendingDbUpdates.clear();

    try {
        await Promise.all(updates.map(async ([executionId, updateData]) => {
            try {
                await prisma.strategy_executions.update({
                    where: { id: executionId },
                    data: updateData
                });
            } catch (err) {
                console.error(`[DbWriter] Error updating execution ${executionId}:`, err.message);
                // Re-add to queue if it's a transient error? For now, just log.
            }
        }));
    } catch (err) {
        console.error("[DbWriter] Fatal error in bulk update:", err.message);
    } finally {
        isWritingToDb = false;
    }
}

// Write to DB every 5 seconds
setInterval(runGlobalDbWriter, 5000);

const INDEX_CONFIGS = {
    "NIFTY": { token: "99926000", exchange: "NSE" },
    "SENSEX": { token: "99919000", exchange: "BSE" }
};

let inFlightLtpRequests = new Map();

async function getLtpSecure({ exchange, symboltoken, connectionId }) {
    const key = `${exchange}_${symboltoken}`;

    // 1. Check WebSocket Cache (Zero Latency)
    if (globalLtpMap[key]) {
        return {
            status: true,
            data: {
                fetched: [{ exchange, symboltoken, ltp: globalLtpMap[key] }]
            }
        };
    }

    // 2. De-duplicate equivalent REST requests already in flight
    const inFlightKey = `${connectionId}_${key}`;
    if (inFlightLtpRequests.has(inFlightKey)) {
        return inFlightLtpRequests.get(inFlightKey);
    }

    // 3. Fallback to REST API
    const requestPromise = marketService.getLTP({ exchange, symboltoken, connectionId });
    inFlightLtpRequests.set(inFlightKey, requestPromise);

    try {
        const result = await requestPromise;
        return result;
    } finally {
        // Clear from in-flight map after a small window to allow fresh fetches
        // while effectively blocking the millisecond burst.
        setTimeout(() => inFlightLtpRequests.delete(inFlightKey), 500);
    }
}

/**
 * Robust LTP fetcher that retries up to 3 times on failure.
 * Returns the LTP number directly, or null if all retries fail.
 */
async function getLtpWithRetry({ exchange, symboltoken, connectionId, currentLtp = 0 }) {
    let retryCount = 0;
    while (retryCount <= 3) {
        try {
            const res = await getLtpSecure({ exchange, symboltoken, connectionId });
            if (res.status && res.data?.fetched?.[0]?.ltp > 0) {
                return res.data.fetched[0].ltp;
            }
            if (currentLtp > 0) return currentLtp; // Fallback to provided memory LTP if valid
        } catch (err) {}

        if (retryCount < 3) {
            retryCount++;
            await new Promise(r => setTimeout(r, 1000));
        } else {
            break;
        }
    }
    return null;
}

async function runGlobalWebsocketSync() {
    // --- Build Unified Task Map ---
    const unifiedTasks = {}; // { exchange: Set(tokens) }

    for (const [id, strategy] of activeStrategies) {
        // Optimization: Even if WAITING, subscribe to the Index price so it's
        // ready in cache (globalLtpMap) for a zero-latency entry at 9:16 AM.
        if (strategy.status === "WAITING" && strategy.config?.index) {
            const idxConfig = INDEX_CONFIGS[strategy.config.index];
            if (idxConfig) {
                if (!unifiedTasks[idxConfig.exchange]) unifiedTasks[idxConfig.exchange] = new Set();
                unifiedTasks[idxConfig.exchange].add(idxConfig.token);
            }
        }

        if (strategy.status !== "IN_POSITION" || !strategy.legs) continue;

        for (const leg of strategy.legs) {
            if ((leg.exited && leg.state !== "WAITING_FOR_RECOST") || !leg.instrument) continue;
            const exch = leg.instrument.exch_seg;
            const token = leg.instrument.token;

            if (!unifiedTasks[exch]) unifiedTasks[exch] = new Set();
            unifiedTasks[exch].add(token);
        }
    }

    marketSocketService.syncSubscriptions(unifiedTasks);
}

// Start websocket sync heartbeat once globally
setInterval(runGlobalWebsocketSync, 1000);

function updateStrategyInMemory(executionId, data) {
    const strategy = activeStrategies.get(executionId);
    
    // Merge into pending updates instead of direct DB call
    const existing = pendingDbUpdates.get(executionId) || { execution_details: {} };
    const updateData = { ...existing };
    
    // Core fields
    if (data.status) updateData.status = data.status;
    if (data.final_pnl_percent !== undefined) updateData.final_pnl_percent = data.final_pnl_percent;
    if (data.totalPnlRupees !== undefined) updateData.total_pnl_rupees = data.totalPnlRupees;
    if (data.exit_type) updateData.exit_type = data.exit_type;

    // Build/Merge JSON details
    const currentDetails = updateData.execution_details || {};
    
    updateData.execution_details = {
        ...currentDetails,
        ...(data.execution_details || {}),
        _latest: new Date().toISOString()
    };

    // Ensure we ALWAYS preserve the runtime config if available in memory
    if (strategy && strategy.config) {
        updateData.execution_details.config = strategy.config;
    }

    // Capture arbitrary keys from 'data' into the JSON blob
    for (const key of Object.keys(data)) {
        if (['status', 'final_pnl_percent', 'totalPnlRupees', 'exit_type', 'execution_details'].includes(key)) continue;

        let val = data[key];
        if (Array.isArray(val)) {
            val = val.map(item => item === undefined ? null : item);
        }
        updateData.execution_details[key] = val;
    }

    if (["COMPLETED", "FAILED", "STOPPED", "SQUARED_OFF", "TERMINATED"].includes(data.status)) {
        updateData.completed_at = new Date().toISOString();
        // Trigger immediate DB flush for terminal states so they appear in history instantly
        setTimeout(runGlobalDbWriter, 0);
    }

    pendingDbUpdates.set(executionId, updateData);
}

function addStrategyLog(strategyId, message, level = "INFO") {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;

    const logEntry = {
        time: getISTFullDate(),
        message,
        level: level.toUpperCase()
    };

    if (!strategy.logs) strategy.logs = [];
    strategy.logs.push(logEntry);
    updateStrategyInMemory(strategyId, { logs: strategy.logs });

    marketSocketService.sendStrategyLog(strategyId, logEntry);

    const isCriticalProcess = level === "CRITICAL" || level === "ERROR" ||
        message.toUpperCase().includes("REENTRY") ||
        message.toUpperCase().includes("RE-COST") ||
        message.toUpperCase().includes("RE ASAP") ||
        message.toUpperCase().includes("STOP OUT") ||
        message.toUpperCase().includes("STOPPED OUT") ||
        message.toUpperCase().includes("EXIT") ||
        message.toUpperCase().includes("SQUARING OFF") ||
        message.toUpperCase().includes("CHASE");

    if (isCriticalProcess) {
        console.log(`[Log][${strategyId}] ${message}`);
    }
}

async function getStatus(strategyId) {
    const s = activeStrategies.get(strategyId);
    if (s) {
        return {
            id: s.id,
            status: s.status,
            config: s.config,
            error: s.error,
            legs: s.legs || [],
            pnlPercent: s.pnlPercent || 0,
            totalPnlRupees: s.totalPnlRupees || 0,
            totalOriginalValue: s.totalOriginalValue || 0,
            orderId: s.orderId,
            exitOrderId: s.exitOrderId,
            exitType: s.exitType,
            instrument: s.instrument,
            logs: s.logs || [],
            name: s.config?.name || "Deployed Strategy"
        };
    }

    const { withDbRetry } = require("./strategy.crud");
    const dbExec = await withDbRetry(() =>
        prisma.strategy_executions.findUnique({
            where: { id: strategyId },
            include: { strategy: { select: { name: true } } }
        })
    ).catch(() => null);

    if (!dbExec) return null;

    return {
        id: dbExec.id,
        status: dbExec.status,
        config: dbExec.execution_details?.config || {},
        name: dbExec.strategy?.name || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        legs: dbExec.execution_details?.legs || [],
        logs: dbExec.execution_details?.logs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalTotalPnlRupees: dbExec.total_pnl_rupees || 0,
        exitType: dbExec.exit_type
    };
}

module.exports = {
   activeStrategies,
   globalLtpMap,
   updateLtp,
   getLtpSecure,
   getLtpWithRetry,
   runGlobalDbWriter,
   updateStrategyInMemory,
   runGlobalWebsocketSync,
   addStrategyLog,
   getStatus
};
