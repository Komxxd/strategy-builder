const sql = require("../../config/db");
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

    const { withDbRetry } = require("./strategy.crud");

    try {
        // SERIALIZE writes instead of Promise.all to prevent pool exhaustion.
        // With max:5 connections and potentially 8+ strategies, parallel writes 
        // can saturate the pool and cause CONNECT_TIMEOUT cascades.
        for (const [executionId, updateData] of updates) {
            try {
                await withDbRetry(() => sql`
                    UPDATE strategy_executions 
                    SET ${sql(updateData)}
                    WHERE id = ${executionId}
                `, 3, 500); 
            } catch (err) {
                console.error(`[DbWriter] Permanent failure for execution ${executionId}:`, err.message);
                console.log(`[DbWriter] Re-queueing update for ${executionId} for next cycle.`);
                const current = pendingDbUpdates.get(executionId) || {};
                pendingDbUpdates.set(executionId, { ...updateData, ...current });
            }
        }
    } catch (err) {
        console.error("[DbWriter] Fatal error in bulk update loop:", err.message);
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

    if (globalLtpMap[key]) {
        return {
            status: true,
            data: {
                fetched: [{ exchange, symboltoken, ltp: globalLtpMap[key] }]
            }
        };
    }

    const inFlightKey = `${connectionId}_${key}`;
    if (inFlightLtpRequests.has(inFlightKey)) {
        return inFlightLtpRequests.get(inFlightKey);
    }

    const requestPromise = marketService.getLTP({ exchange, symboltoken, connectionId });
    inFlightLtpRequests.set(inFlightKey, requestPromise);

    try {
        const result = await requestPromise;
        return result;
    } finally {
        setTimeout(() => inFlightLtpRequests.delete(inFlightKey), 500);
    }
}

async function getLtpWithRetry({ exchange, symboltoken, connectionId, currentLtp = 0 }) {
    let retryCount = 0;
    while (retryCount <= 3) {
        try {
            const res = await getLtpSecure({ exchange, symboltoken, connectionId });
            if (res.status && res.data?.fetched?.[0]?.ltp > 0) {
                return res.data.fetched[0].ltp;
            }
            if (currentLtp > 0) return currentLtp; 
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
    const unifiedTasks = {}; 

    for (const [id, strategy] of activeStrategies) {
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

setInterval(runGlobalWebsocketSync, 1000);

function updateStrategyInMemory(executionId, data) {
    const strategy = activeStrategies.get(executionId);
    
    const existing = pendingDbUpdates.get(executionId) || { execution_details: {} };
    const updateData = { ...existing };
    
    if (data.status) updateData.status = data.status;
    if (data.final_pnl_percent !== undefined) updateData.final_pnl_percent = data.final_pnl_percent;
    if (data.totalPnlRupees !== undefined) updateData.total_pnl_rupees = data.totalPnlRupees;
    if (data.exit_type) updateData.exit_type = data.exit_type;

    const currentDetails = updateData.execution_details || {};
    
    updateData.execution_details = {
        ...currentDetails,
        ...(data.execution_details || {}),
        _latest: new Date().toISOString()
    };

    if (strategy && strategy.config) {
        updateData.execution_details.config = strategy.config;
    }

    for (const key of Object.keys(data)) {
        if (['status', 'final_pnl_percent', 'totalPnlRupees', 'exit_type', 'execution_details'].includes(key)) continue;

        let val = data[key];
        if (Array.isArray(val)) {
            val = val.map(item => item === undefined ? null : item);
        }
        updateData.execution_details[key] = val;
    }

    if (["COMPLETED", "FAILED", "STOPPED", "SQUARED_OFF", "TERMINATED"].includes(data.status)) {
        updateData.completed_at = new Date();
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
            strategy_id: s.strategy_id,
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
    const [dbExec] = await withDbRetry(() =>
        sql`
            SELECT e.*, s.name as strategy_name
            FROM strategy_executions e
            LEFT JOIN strategies s ON e.strategy_id = s.id
            WHERE e.id = ${strategyId}
            LIMIT 1
        `
    ).catch(() => [null]);

    if (!dbExec) return null;

    return {
        id: dbExec.id,
        strategy_id: dbExec.strategy_id,
        status: dbExec.status,
        config: {
            ...(dbExec.execution_details?.config || {}),
            is_paper_trading: dbExec.is_paper_trading
        },
        name: dbExec.strategy_name || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        legs: dbExec.execution_details?.legs || [],
        logs: dbExec.execution_details?.logs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalPnlRupees: dbExec.total_pnl_rupees || 0,
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
