const { getAuthorizedInstance } = require("../config/smartapi");
const marketService = require("./market.service");
const marketSocketService = require("./marketSocket.service");
const prisma = require("../config/prisma");
const fs = require("fs");
const path = require("path");
const redis = require("../config/redis");

const INSTRUMENT_PATH = path.join(__dirname, "../data/instruments.json");
let instruments = [];
let activeStrategies = new Map();
let globalLtpMap = {};

function updateLtp(key, price) {
    globalLtpMap[key] = price;
}

let isFetchingGlobalLtp = false;

/**
 * Singleton background fetcher that aggregates all tokens from all active strategies
 * and fetches their LTP in chunks of 40 to stay within SmartAPI batch limits.
 */
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

async function runGlobalWebsocketSync() {
    // --- Build Unified Task Map ---
    const unifiedTasks = {}; // { exchange: Set(tokens) }

    for (const [id, strategy] of activeStrategies) {
        if (strategy.status !== "IN_POSITION" || !strategy.legs) continue;

        for (const leg of strategy.legs) {
            if ((leg.exited && leg.state !== "WAITING_FOR_RECOST") || !leg.instrument) continue;
            const exch = leg.instrument.exch_seg;
            const token = leg.instrument.token;

            if (!unifiedTasks[exch]) unifiedTasks[exch] = new Set();
            unifiedTasks[exch].add(token);
        }
    }

    // --- WebSocket Sync (even if 0 active) ---
    // If no active strategies, unifiedTasks will be empty {}
    // syncSubscriptions will correctly unsubscribe from everything.
    marketSocketService.syncSubscriptions(unifiedTasks);
}

// Start websocket sync heartbeat once globally
setInterval(runGlobalWebsocketSync, 1000);

function loadInstruments() {
    if (instruments.length > 0) return;
    try {
        if (fs.existsSync(INSTRUMENT_PATH)) {
            const raw = fs.readFileSync(INSTRUMENT_PATH, "utf-8");
            instruments = JSON.parse(raw);
            const fileSizeMB = (Buffer.byteLength(raw, 'utf-8') / (1024 * 1024)).toFixed(1);
            console.log(`Instruments loaded: ${instruments.length} records (${fileSizeMB} MB file)`);
        }
    } catch (err) {
        console.error("Strategy Service: Error loading instruments", err.message);
    }
}

function roundToTick(price, tick = 0.05) {
    if (!price || isNaN(price)) return 0;
    return Number(Math.max(tick, Math.round(price / tick) * tick).toFixed(2));
}

function updateStrategyInMemory(executionId, data) {
    // Merge into pending updates instead of direct DB call
    const existing = pendingDbUpdates.get(executionId) || { execution_details: {} };

    const updateData = { ...existing };
    if (data.status) updateData.status = data.status;
    if (data.final_pnl_percent !== undefined) updateData.final_pnl_percent = data.final_pnl_percent;
    if (data.totalPnlRupees !== undefined) updateData.total_pnl_rupees = data.totalPnlRupees;
    if (data.exit_type) updateData.exit_type = data.exit_type;

    updateData.execution_details = {
        ...updateData.execution_details,
        ...(data.execution_details || {}),
        _latest: new Date().toISOString()
    };

    for (const key of Object.keys(data)) {
        if (['status', 'final_pnl_percent', 'totalPnlRupees', 'exit_type', 'execution_details'].includes(key)) continue;

        let val = data[key];
        if (Array.isArray(val)) {
            val = val.map(item => item === undefined ? null : item);
        }
        updateData.execution_details[key] = val;
    }

    if (data.status === "COMPLETED" || data.status === "FAILED" || data.status === "TERMINATED") {
        updateData.completed_at = new Date().toISOString();
        // For completions, we could potentially force an immediate write, 
        // but for a single user, 5s delay is acceptable and safer for the event loop.
    }

    pendingDbUpdates.set(executionId, updateData);
}

function getATMStrike(indexName, spotPrice) {
    let step = 100;
    if (indexName === "NIFTY" || indexName === "FINNIFTY") step = 50;
    return Math.round(spotPrice / step) * step;
}

/**
 * Gets current time in IST (Asia/Kolkata) as HH:mm:ss
 */
function getISTTime() {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date());
}

/**
 * Gets current formatted time for log window: "Mar 10, 2026 at 09:45:03 AM"
 */
function getISTFullDate() {
    const options = {
        timeZone: 'Asia/Kolkata',
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());

    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    const year = parts.find(p => p.type === 'year').value;
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const second = parts.find(p => p.type === 'second').value;
    const dayPeriod = parts.find(p => p.type === 'dayPeriod').value;

    return `${month} ${day}, ${year} at ${hour}:${minute}:${second} ${dayPeriod}`;
}

/**
 * Adds a log entry to a strategy and broadcasts it to the frontend.
 * @param {string} strategyId 
 * @param {string} message 
 * @param {string} level - "INFO" | "CRITICAL" | "ERROR"
 */
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

    // Persist to DB queue (keep only last 100 logs in RAM to avoid memory leaks, 
    // but DB will have them all if we update strategically)
    // Actually for execution_details, we overwrite, so we should keep them all for the session.
    updateStrategyInMemory(strategyId, { logs: strategy.logs });

    // Live broadcast
    marketSocketService.sendStrategyLog(strategyId, logEntry);

    // Only log to terminal if it's CRITICAL, ERROR, or process logs like re-entry, SL hits
    const isCriticalProcess = level === "CRITICAL" || level === "ERROR" ||
        message.toUpperCase().includes("REENTRY") ||
        message.toUpperCase().includes("RE-COST") ||
        message.toUpperCase().includes("RE ASAP") ||
        message.toUpperCase().includes("STOP OUT") ||
        message.toUpperCase().includes("STOPPED OUT") ||
        message.toUpperCase().includes("EXIT") ||
        message.toUpperCase().includes("SQUARING OFF");

    if (isCriticalProcess) {
        console.log(`[Log][${strategyId}] ${message}`);
    }
}

async function findOptionInstrument(indexName, optionType, strike) {
    let matches = [];
    try {
        const cacheKey = `instr:OPTIDX:${indexName}:${optionType}:${strike}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            matches = JSON.parse(cached);
        } else {
            loadInstruments();
            matches = instruments.filter(inst =>
                inst.name === indexName &&
                inst.instrumenttype === "OPTIDX" &&
                inst.symbol.endsWith(optionType) &&
                (parseFloat(inst.strike) / 100) === strike
            );
            await redis.set(cacheKey, JSON.stringify(matches));
        }
    } catch (err) {
        loadInstruments();
        matches = instruments.filter(inst =>
            inst.name === indexName &&
            inst.instrumenttype === "OPTIDX" &&
            inst.symbol.endsWith(optionType) &&
            (parseFloat(inst.strike) / 100) === strike
        );
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    matches = matches.filter(inst => new Date(inst.expiry) >= today);

    if (matches.length === 0) return null;

    // Sort by expiry to get the nearest one
    matches.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

    return matches[0];
}

async function findClosestPremiumInstrument(indexName, optionType, targetPremium, connectionId) {
    const exchange = indexName === "SENSEX" ? "BFO" : "NFO";
    let matchesRaw = [];

    try {
        const cacheKey = `instr:OPTIDX:${indexName}:${optionType}:ALL`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            matchesRaw = JSON.parse(cached);
        } else {
            loadInstruments();
            matchesRaw = instruments.filter(inst =>
                inst.name === indexName &&
                inst.instrumenttype === "OPTIDX" &&
                inst.symbol.endsWith(optionType)
            );
            await redis.set(cacheKey, JSON.stringify(matchesRaw));
        }
    } catch (err) {
        loadInstruments();
        matchesRaw = instruments.filter(inst =>
            inst.name === indexName &&
            inst.instrumenttype === "OPTIDX" &&
            inst.symbol.endsWith(optionType)
        );
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1. Get all options for this index and type
    const matches = matchesRaw.filter(inst => new Date(inst.expiry) >= today);

    if (matches.length === 0) {
        throw new Error(`[Closest Premium] No ${optionType} instruments found for ${indexName} expiring after today.`);
    }

    // 2. Find the nearest expiry date
    matches.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));
    const nearestExpiry = matches[0].expiry;

    // 3. Filter down to ONLY the strikes for that nearest expiry
    const currentExpiryOptions = matches.filter(inst => inst.expiry === nearestExpiry);
    const tokens = currentExpiryOptions.map(inst => inst.token).filter(Boolean);

    if (tokens.length === 0) {
        throw new Error(`[Closest Premium] No tokens found for ${indexName} ${optionType} expiring on ${nearestExpiry}.`);
    }

    // 4. Batch get LTP for all tokens in this expiry (SmartAPI limits to ~50 per request)
    const tokenChunks = [];
    for (let i = 0; i < tokens.length; i += 40) {
        tokenChunks.push(tokens.slice(i, i + 40));
    }

    let allFetchedData = [];
    for (let i = 0; i < tokenChunks.length; i++) {
        try {
            const chunk = tokenChunks[i];
            const ltpRes = await marketService.getLTP({
                exchange,
                symboltoken: chunk,
                connectionId
            });
            if (ltpRes?.status && ltpRes?.data?.fetched) {
                allFetchedData = allFetchedData.concat(ltpRes.data.fetched);
            } else if (ltpRes?.message) {
                console.error(`SmartAPI Error on chunk ${i}: ${ltpRes.message}`);
            }
        } catch (err) {
            console.error(`Error fetching chunk ${i} for nearest premium:`, err.message);
        }
    }

    if (allFetchedData.length === 0) {
        throw new Error(`[Closest Premium] SmartAPI returned 0 prices. Exchange: ${exchange}, Tokens requested: ${tokens.length}. Connection active?`);
    }

    let closestFound = null;
    let minDiff = Infinity;

    // 5. Find the one with the LTP closest to targetPremium
    for (const fetched of allFetchedData) {
        const diff = Math.abs(fetched.ltp - targetPremium);
        if (diff < minDiff) {
            minDiff = diff;
            closestFound = fetched;
        }
    }

    if (!closestFound) {
        throw new Error(`[Closest Premium] Could not determine closest premium mathematically for ₹${targetPremium}.`);
    }

    // 6. Return the full instrument object for the winning token
    const matchingTarget = closestFound.symbolToken || closestFound.symboltoken;
    const winner = currentExpiryOptions.find(inst => inst.token === matchingTarget);
    if (!winner) {
        throw new Error(`[Closest Premium] Matched token ${matchingTarget} not found in options list!`);
    }
    return winner;
}

async function placeOrder(config, instrument, connectionId) {
    const isPaperTrading = config.is_paper_trading === true;
    const connId = connectionId || config.connectionId;

    const orderParams = {
        variety: config.variety || "NORMAL",
        tradingsymbol: instrument.symbol,
        symboltoken: instrument.token,
        transactiontype: config.side || "BUY",
        exchange: instrument.exch_seg,
        ordertype: config.ordertype || "MARKET",
        producttype: config.producttype || "INTRADAY",
        duration: config.duration || "DAY",
        price: (config.price || "0").toString(),
        triggerprice: (config.triggerprice || "0").toString(),
        squareoff: (config.squareoff || "0").toString(),
        stoploss: (config.stoploss || "0").toString(),
        quantity: (config.lots * parseInt(instrument.lotsize)).toString(),
        scripconsent: "yes"
    };

    if (isPaperTrading) {
        console.log(`[${new Date().toISOString()}] PAPER ORDER:`, orderParams);
        return {
            orderid: `PAPER_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            uniqueorderid: `UPAPER_${Date.now()}`
        };
    }

    try {
        console.log(`[${new Date().toISOString()}] Placing order:`, orderParams);
        const api = await getAuthorizedInstance(connId);
        const response = await api.placeOrder(orderParams);
        if (response.status && response.data) {
            console.log(`[${new Date().toISOString()}] Order placed successfully:`, response.data.orderid);
            return response.data; // contains orderid and uniqueorderid
        }
        throw new Error(response.message || "Order placement failed");
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Order placement failed:`, error);
        throw error;
    }
}

function computeStopLossExitPrices(entryPrice, side, slType, slValue, limitMargin) {
    const val = Number(slValue || 0);
    const margin = Number(limitMargin || 0);
    if (!entryPrice || val <= 0) return null;

    let trigger;
    if (slType === "POINTS") {
        trigger = side === "BUY"
            ? entryPrice - val
            : entryPrice + val;
    } else {
        // Default to PERCENTAGE
        trigger = side === "BUY"
            ? entryPrice * (1 - val / 100)
            : entryPrice * (1 + val / 100);
    }

    const limit = side === "BUY"
        ? trigger - margin
        : trigger + margin;

    return {
        trigger: roundToTick(trigger),
        limit: roundToTick(limit)
    };
}

function resolveUniversalOrderParams({ targetPrice, currentLtp, side, offset }) {
    let variety = "NORMAL";
    let ordertype = "LIMIT";
    let price = targetPrice;
    let triggerprice = "0";

    const roundedTarget = roundToTick(targetPrice);
    const roundedLtp = roundToTick(currentLtp);

    if (side === "SELL") {
        if (roundedTarget < roundedLtp) {
            // Sell BELOW current LTP -> Stop Loss Limit (Breakout Down)
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            triggerprice = roundedTarget.toString();
            price = roundToTick(roundedTarget - offset).toString();
        } else {
            // Sell ABOVE current LTP -> Regular Limit (Retracement Up)
            variety = "NORMAL";
            ordertype = "LIMIT";
            price = roundToTick(roundedTarget - offset).toString();
        }
    } else {
        // side === "BUY"
        if (roundedTarget > roundedLtp) {
            // Buy ABOVE current LTP -> Stop Loss Limit (Breakout Up)
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            triggerprice = roundedTarget.toString();
            price = roundToTick(roundedTarget + offset).toString();
        } else {
            // Buy BELOW current LTP -> Regular Limit (Retracement Down)
            variety = "NORMAL";
            ordertype = "LIMIT";
            price = roundToTick(roundedTarget + offset).toString();
        }
    }

    return { variety, ordertype, price, triggerprice };
}

async function waitForOrderFillPrice(uniqueOrderId, connectionId, isPaperTrading = false, instrument = null, timeoutMs = 60000, pollMs = 2000, paperConfig = null) {
    if (isPaperTrading) {
        // If no specifically monitored target price is provided, fill instantly at LTP (Standard Entry)
        if (!paperConfig || paperConfig.ordertype === "MARKET" || paperConfig.ordertype === "LIMIT") {
            try {
                if (instrument) {
                    const ltpRes = await marketService.getLTP({
                        exchange: instrument.exch_seg,
                        symboltoken: instrument.token,
                        connectionId: connectionId
                    });
                    if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
                        const ltp = ltpRes.data.fetched[0].ltp;
                        console.log(`[PAPER_FILL] Instant Fill for ${instrument.symbol} at ${ltp} (${paperConfig?.ordertype || 'MARKET'})`);
                        return ltp;
                    }
                }
            } catch (err) {
                console.error("Error getting paper fill price:", err);
            }
            return null;
        }

        // Advanced Mode: Monitor for Limit / Stoploss crossing (Used for Re-cost RTP and Momentum MTP)
        const start = Date.now();
        const effectiveTarget = (paperConfig.triggerprice > 0) ? paperConfig.triggerprice : paperConfig.price;
        const targetDesc = (paperConfig.triggerprice > 0) ? `Target Trigger (MTP/RTP): ${effectiveTarget}` : `Target Price: ${effectiveTarget}`;
        console.log(`[PAPER_SIMULATOR] Monitoring ${instrument?.symbol} ${paperConfig.ordertype} ${paperConfig.side} specifically reaching ${targetDesc}`);

        while (Date.now() - start < timeoutMs) {
            try {
                if (instrument) {
                    const ltpRes = await marketService.getLTP({
                        exchange: instrument.exch_seg,
                        symboltoken: instrument.token,
                        connectionId: connectionId
                    });

                    if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
                        const ltp = ltpRes.data.fetched[0].ltp;
                        const { side, ordertype, price, triggerprice } = paperConfig;

                        // Determine the primary target price we are waiting for (MTP, RTP, or Limit Price)
                        const target = (triggerprice > 0) ? triggerprice : price;

                        if (ordertype === "LIMIT") {
                            // BUY LIMIT executes only when LTP falls to or below target
                            if (side === "BUY" && ltp <= target) return target;
                            // SELL LIMIT executes only when LTP climbs to or above target
                            if (side === "SELL" && ltp >= target) return target;
                        }
                        else if (ordertype === "STOPLOSS_LIMIT" || ordertype === "STOPLOSS") {
                            // Momentum BUY (BUY above current)
                            if (side === "BUY" && ltp >= target) return target;
                            // Momentum SELL (SELL below current)
                            if (side === "SELL" && ltp <= target) return target;
                        }
                    }
                }
            } catch (err) { /* Silently retry next poll */ }
            await new Promise(r => setTimeout(r, pollMs));
        }
        return null;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const api = await getAuthorizedInstance(connectionId);
            const details = await api.indOrderDetails(uniqueOrderId);
            if (details?.status && details?.data) {
                const avgPrice = Number(details.data.averageprice || details.data.averagePrice || 0);
                const filledShares = Number(details.data.filledshares || details.data.filledShares || 0);
                const orderStatus = (details.data.orderstatus || details.data.status || "").toString().toLowerCase();
                if ((avgPrice > 0 && filledShares > 0) || orderStatus === "complete" || orderStatus === "filled") {
                    return avgPrice > 0 ? avgPrice : null;
                }

                if (orderStatus === "rejected" || orderStatus === "cancelled") {
                    throw new Error(`Order ${orderStatus}: ${details.data.text || details.data.message || ""}`);
                }
            }
        } catch (err) {
            if (err.message.includes("Order rejected") || err.message.includes("Order cancelled")) {
                throw err;
            }
            console.error("Error polling order details:", err.message);
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
}

async function placeStopLossExitOrder({ baseConfig, legSide, entryPrice, instrument, lots, slType, slValue, slLimitMargin, connectionId }) {
    const prices = computeStopLossExitPrices(
        entryPrice,
        legSide,
        slType,
        slValue,
        slLimitMargin
    );
    if (!prices) return null;

    const slConfig = {
        ...baseConfig,
        lots: lots,
        variety: "STOPLOSS",
        ordertype: "STOPLOSS_LIMIT",
        side: legSide === "BUY" ? "SELL" : "BUY",
        price: prices.limit.toString(),
        triggerprice: prices.trigger.toString(),
    };

    return await placeOrder(slConfig, instrument, connectionId);
}

async function placeStopLossWithRetry({ baseConfig, legSide, entryPrice, instrument, lots, slType, slValue, slLimitMargin, connectionId, strategyId }) {
    let attempts = 3;
    let slOrder = null;
    let lastError = "";

    while (attempts > 0) {
        try {
            slOrder = await placeStopLossExitOrder({
                baseConfig, legSide, entryPrice, instrument, lots, slType, slValue, slLimitMargin, connectionId
            });
            if (slOrder?.orderid) {
                if (attempts < 3) {
                    marketSocketService.sendAlert(`SL order for ${instrument.symbol} successfully placed on attempt ${4 - attempts}.`, "success");
                    if (strategyId) addStrategyLog(strategyId, `SL order for ${instrument.symbol} placed on attempt ${4 - attempts}.`, "INFO");
                } else {
                    if (strategyId) addStrategyLog(strategyId, `SL order for ${instrument.symbol} placed at trigger ₹${slOrder.triggerprice || '---'}.`, "INFO");
                }
                return slOrder;
            }
        } catch (err) {
            lastError = err.message;
            console.error(`[SL Retry] Attempt ${4 - attempts} for ${instrument.symbol} failed:`, lastError);
            marketSocketService.sendAlert(`SL placement failed for ${instrument.symbol} (Attempt ${4 - attempts}): ${lastError}`, "error");
            if (strategyId) addStrategyLog(strategyId, `SL placement FAILED for ${instrument.symbol} (Attempt ${4 - attempts}): ${lastError}`, "ERROR");
        }

        attempts--;
        if (attempts > 0 && (!slOrder || !slOrder.orderid)) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    marketSocketService.sendAlert(`CRITICAL: Stop Loss order for ${instrument.symbol} FAILED after all attempts. Position is UNPROTECTED!`, "error");
    if (strategyId) addStrategyLog(strategyId, `CRITICAL: Stop Loss order for ${instrument.symbol} FAILED after all attempts. Position is UNPROTECTED!`, "CRITICAL");
    return null;
}

async function placeExitOrder({ config, leg, instrument, exitType }) {
    if (leg.exited) return leg.exitOrderId;
    if (leg.isExiting && !config.is_paper_trading) return leg.exitOrderId;

    if (!instrument) {
        console.log(`[Exit] Leg has no instrument (State: ${leg.state}). Marking as exited.`);
        leg.exited = true;
        leg.isExiting = false;
        leg.exitType = exitType || "SKIPPED_NO_INSTRUMENT";
        leg.exitTime = getISTTime();
        return null;
    }

    // FIX: Do not place an exit order if the leg never actually entered (e.g. waiting for RTP/MTP)
    if (!leg.entryPrice) {
        if (leg.orderId && !config.is_paper_trading) {
            console.log(`[Exit] Leg ${instrument.symbol} has orderId ${leg.orderId} but no entry price. Attempting cancellation...`);
            try {
                const api = await getAuthorizedInstance(config.connectionId);
                await api.cancelOrder({ variety: "NORMAL", orderid: leg.orderId });
                console.log(`[Exit] Successfully cancelled pending entry order ${leg.orderId}`);
                leg.exited = true;
                leg.isExiting = false;
                leg.exitType = exitType || "CANCELLED_NO_ENTRY";
                leg.exitTime = getISTTime();
                return null;
            } catch (e) {
                console.warn(`[Exit] Cancellation failed for ${leg.orderId}: ${e.message}. It may have filled. Proceeding with MARKET exit.`);
            }
        } else {
            console.log(`[Exit] Leg ${instrument.symbol} has no entry price (State: ${leg.state}). Skipping broker order.`);
            leg.exited = true;
            leg.isExiting = false;
            leg.exitType = exitType || "SKIPPED_NO_ENTRY";
            leg.exitTime = getISTTime();
            return null;
        }
    }

    leg.isExiting = true;

    try {
        const exitSide = leg.leg.side === "BUY" ? "SELL" : "BUY";
        // FORCE MARKET exit if we are retrying (isExiting was already true in a previous tick)
        let exitOrderType = (leg.exitRetryCount > 0) ? "MARKET" : (config.ordertype === "LIMIT" ? "LIMIT" : "MARKET");
        let finalPrice = "0";

        if (exitOrderType === "LIMIT") {
            const ltpRes = await marketService.getLTP({
                exchange: instrument.exch_seg,
                symboltoken: instrument.token,
                connectionId: config.connectionId
            });
            if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
                const ltp = ltpRes.data.fetched[0].ltp;
                const offset = parseFloat(config.entry_limit_offset || 0);
                if (exitSide === "SELL") finalPrice = roundToTick(ltp - offset).toString();
                else finalPrice = roundToTick(ltp + offset).toString();
            } else if (leg.currentLtp) {
                const ltp = leg.currentLtp;
                const offset = parseFloat(config.entry_limit_offset || 0);
                if (exitSide === "SELL") finalPrice = roundToTick(ltp - offset).toString();
                else finalPrice = roundToTick(ltp + offset).toString();
            } else {
                exitOrderType = "MARKET";
            }
        }

        const closeConfig = {
            ...config,
            side: exitSide,
            variety: "NORMAL",
            ordertype: exitOrderType,
            price: finalPrice,
            lots: leg.leg.lots
        };

        const orderData = await placeOrder(closeConfig, instrument, config.connectionId);
        leg.exitOrderId = orderData.orderid;
        leg.exitUniqueOrderId = orderData.uniqueorderid;
        leg.exitType = exitType;
        leg.exitTime = getISTTime();

        if (config.is_paper_trading) {
            leg.exited = true;
            leg.isExiting = false;
            return orderData.orderid;
        }

        // --- Verified Exit (Live Only) ---
        // Monitor fill status in background
        setTimeout(async () => {
            try {
                const fill = await waitForOrderFillPrice(
                    leg.exitUniqueOrderId,
                    config.connectionId,
                    false,
                    leg.instrument,
                    2000, // Timeout after 2 seconds
                    1000  // Poll every 1s
                );

                if (fill) {
                    leg.exited = true;
                    leg.isExiting = false;
                    addStrategyLog(config.id || "system", `Exit confirmed for ${instrument.symbol} at ₹${fill}.`, "SUCCESS");
                } else {
                    // Missed price / Timeout
                    console.warn(`[Exit Poller] Order ${leg.exitOrderId} pending for 2s. Retrying via MARKET.`);
                    addStrategyLog(config.id || "system", `Exit order for ${instrument.symbol} pending for 2s. Escalating to Market order...`, "WARNING");

                    const api = await getAuthorizedInstance(config.connectionId);
                    await api.cancelOrder({ variety: "NORMAL", orderid: leg.exitOrderId });

                    leg.exitRetryCount = (leg.exitRetryCount || 0) + 1;
                    leg.isExiting = false; // Allow monitor loop to trigger retry
                }
            } catch (pollErr) {
                console.error(`[Exit Poller] Error verifying exit for ${instrument.symbol}:`, pollErr.message);
                leg.isExiting = false; // Allow retry on error
            }
        }, 0);

        return orderData.orderid;
    } catch (error) {
        console.error(`[Exit] Failed to place exit order for ${instrument.symbol}:`, error.message);
        addStrategyLog(config.id || "system", `CRITICAL: Exit placement FAILED for ${instrument.symbol}: ${error.message}. Re-attempting...`, "ERROR");

        leg.isExiting = false; // Allow monitor loop to re-attempt on next tick
        return null;
    }
}

function getLegStrikeSelection({ index, option_type, strike, spotPrice }) {
    const atmStrike = getATMStrike(index, spotPrice);
    const strikeStr = strike || "ATM";
    const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
    const type = match ? match[1] : "ATM";
    const offset = match && match[2] ? parseInt(match[2]) : 0;

    let step = 100;
    if (index === "NIFTY") step = 50;
    else if (index === "FINNIFTY") step = 50;

    let targetStrike = atmStrike;
    if (type === "OTM") {
        targetStrike = option_type === "CE" ? atmStrike + (offset * step) : atmStrike - (offset * step);
    } else if (type === "ITM") {
        targetStrike = option_type === "CE" ? atmStrike - (offset * step) : atmStrike + (offset * step);
    }

    return { atmStrike, targetStrike, strikeLabel: strikeStr };
}

async function handleLegStopOut(leg, exitType, strategy) {
    // 1. Lock PnL and Mark CURRENT leg as completely exited
    leg.state = "COMPLETED";
    leg.exited = true;
    leg.exitType = exitType;
    leg.bookedPnlPoints = (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0);
    leg.bookedPnlRupees = (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0);
    leg.currentActivePnlPoints = 0;
    leg.currentActivePnlRupees = 0;

    // Capture the exact trigger and execution price at the very millisecond of stop-out for the UI history
    leg.exitSnapshot = {
        slTriggerPrice: leg.slTriggerPrice,
        exitLtp: leg.currentLtp,
        exitTime: getISTTime()
    };
    leg.exitTime = getISTTime();

    // Wipe exchange fields to ensure clean exit visualization
    leg.slOrderId = null;
    leg.slUniqueOrderId = null;
    leg.slLimitPrice = null;
    leg.slTriggerPrice = null;
    leg.exchangeSlProcessed = true;

    addStrategyLog(strategy.id, `Leg stopped out: ${leg.instrument.symbol}. Reason: ${exitType}. PnL: ₹${leg.pnlRupees.toFixed(2)}`, exitType.includes("ERROR") ? "ERROR" : "INFO");

    // RE ASAP (Re-Entry As Soon As Possible)
    if (leg.leg.re_asap_enabled && (leg.reentry_count < (leg.leg.re_asap_max_entries || 1))) {
        addStrategyLog(strategy.id, `RE ASAP triggered for ${leg.instrument.symbol}. Re-calculating entry for reentry #${leg.reentry_count + 1}`, "INFO");

        const newLeg = {
            leg: { ...leg.leg },
            instrument: null, // To be re-selected on next tick
            orderId: `VU-ASAP-${Date.now()}`,
            uniqueOrderId: `VU-ASAP-${Date.now()}`,
            state: "WAITING_FOR_RE_ASAP",
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: leg.currentLtp,
            last_tick_price: leg.currentLtp,
            reentry_count: leg.reentry_count + 1,
            original_traded_price: 0,
            base_otp: leg.base_otp || leg.original_traded_price,
            bookedPnlPoints: (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0),
            bookedPnlRupees: (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0),
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            pnlPercent: leg.pnlPercent || 0,
            pnlPoints: leg.pnlPoints || 0,
            pnlRupees: leg.pnlRupees || 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
        return;
    }

    if (leg.leg.recost_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        const otp = leg.base_otp || leg.original_traded_price;
        const mode = leg.leg.recost_mode || "RECOST_PLUS_PCT";
        const val = leg.leg.recost_value || 0;
        let rtp = otp;

        if (mode === "RECOST_PLUS_PCT") rtp = otp + (otp * val / 100);
        else if (mode === "RECOST_PLUS_PTS") rtp = otp + val;
        else if (mode === "RECOST_MINUS_PCT") rtp = otp - (otp * val / 100);
        else if (mode === "RECOST_MINUS_PTS") rtp = otp - val;

        const newRtp = roundToTick(rtp);
        const config = strategy.config;
        const currentLtp = leg.currentLtp || newRtp;
        const side = leg.leg.side;

        if (leg.leg.recost_mntm_enabled) {
            console.log(`[RE-COST MNTM] SL Hit for ${leg.instrument.symbol}. Setting state to WAITING_FOR_MNTM. Target RTP=${newRtp}`);
            const newLeg = {
                leg: { ...leg.leg }, // keep the configuration identical
                instrument: { ...leg.instrument },
                orderId: null,
                uniqueOrderId: null,
                exitOrderId: null,
                state: "WAITING_FOR_MNTM",
                legIndex: leg.legIndex,
                exited: false,
                exitType: null,
                isExiting: false,
                entryPrice: null,
                currentLtp: currentLtp,
                last_tick_price: currentLtp,
                reentry_count: leg.reentry_count, // Note: We increment this once the cross happens
                original_traded_price: 0,
                base_otp: otp,
                recost_trigger_price: newRtp,
                bookedPnlPoints: 0,
                bookedPnlRupees: 0,
                currentActivePnlPoints: 0,
                currentActivePnlRupees: 0,
                currentActivePnlPercent: 0,
                pnlPercent: 0,
                pnlPoints: 0,
                pnlRupees: 0,
                slOrderId: null,
                slUniqueOrderId: null,
                slTriggerPrice: null,
                slLimitPrice: null,
                rtp: newRtp,
                mtp: null,
                exchangeSlProcessed: false
            };
            strategy.legs.push(newLeg);
            return; // We wait.
        }

        let variety = config.variety || "NORMAL";
        let ordertype = config.ordertype || "LIMIT";
        const offset = parseFloat(config.entry_limit_offset || 0);

        let finalPriceStr = newRtp.toString();
        let triggerPriceStr = newRtp.toString();

        if (side === "SELL") {
            if (newRtp < currentLtp) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(newRtp - offset).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                finalPriceStr = roundToTick(newRtp - offset).toString();
            }
        } else if (side === "BUY") {
            if (newRtp > currentLtp) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(newRtp + offset).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                finalPriceStr = roundToTick(newRtp + offset).toString();
            }
        }

        const newLeg = {
            leg: { ...leg.leg }, // keep the configuration identical
            instrument: { ...leg.instrument },
            orderId: null,
            uniqueOrderId: null,
            exitOrderId: null,
            legIndex: leg.legIndex,
            state: "ACTIVE", // Start instantly bypassing WAITING_FOR_RECOST
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: currentLtp,
            last_tick_price: currentLtp,
            reentry_count: leg.reentry_count + 1,
            original_traded_price: 0,
            base_otp: otp,
            recost_trigger_price: newRtp,
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            currentActivePnlPercent: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            rtp: newRtp,
            mtp: null,
            exchangeSlProcessed: false
        };

        strategy.legs.push(newLeg);

        try {
            console.log(`[RE-COST] Firing Immediate Re-Cost Order for ${newLeg.instrument.symbol}. RTP=${newRtp}, LTP=${currentLtp}, Var/Type=${variety}/${ordertype}`);
            const reEntryOrder = await placeOrder(
                {
                    ...config,
                    side: side,
                    variety: variety,
                    ordertype: ordertype,
                    price: finalPriceStr,
                    triggerprice: triggerPriceStr,
                    lots: newLeg.leg.lots
                },
                newLeg.instrument,
                config.connectionId
            );

            newLeg.orderId = reEntryOrder.orderid;
            newLeg.uniqueOrderId = reEntryOrder.uniqueorderid;

            // Wait for fill cleanly in background (allow up to 8 hours for Limits to cross)
            setTimeout(async () => {
                try {
                    const fill = await waitForOrderFillPrice(
                        newLeg.uniqueOrderId,
                        config.connectionId,
                        config.is_paper_trading === true,
                        newLeg.instrument,
                        28800000, // 8 Hours Timeout MS
                        1000,     // 2 Sec Poll Interval
                        {         // Inject Advanced Paper Config
                            side: side,
                            ordertype: ordertype,
                            price: parseFloat(finalPriceStr || 0),
                            triggerprice: parseFloat(triggerPriceStr || 0)
                        }
                    );
                    newLeg.entryPrice = fill || currentLtp;
                    newLeg.entryTime = getISTTime();
                    newLeg.original_traded_price = newLeg.entryPrice;
                    // base_otp is inherited and stays constant across re-entries
                } catch (e) {
                    newLeg.entryPrice = currentLtp;
                    newLeg.entryTime = getISTTime();
                }

                if (config.variety === "STOPLOSS" && newLeg.entryPrice) {
                    const activeSlType = newLeg.leg.reentry_sl_enabled ? newLeg.leg.reentry_sl_type : (newLeg.leg.sl_type || "PERCENTAGE");
                    const activeSlValue = newLeg.leg.reentry_sl_enabled ? newLeg.leg.reentry_sl_value : newLeg.leg.stop_loss;

                    const slOrder = await placeStopLossWithRetry({
                        baseConfig: config,
                        legSide: newLeg.leg.side,
                        entryPrice: newLeg.entryPrice,
                        instrument: newLeg.instrument,
                        lots: newLeg.leg.lots,
                        slType: activeSlType,
                        slValue: activeSlValue,
                        slLimitMargin: config.entry_limit_offset,
                        connectionId: config.connectionId,
                        strategyId: strategy.id
                    });
                    if (slOrder?.orderid) {
                        const prices = computeStopLossExitPrices(newLeg.entryPrice, newLeg.leg.side, activeSlType, activeSlValue, config.entry_limit_offset);
                        newLeg.slOrderId = slOrder.orderid;
                        newLeg.slUniqueOrderId = slOrder.uniqueorderid;
                        newLeg.slTriggerPrice = prices?.trigger;
                        newLeg.slLimitPrice = prices?.limit;
                        newLeg.exchangeSlProcessed = false;
                    }
                }
            }, 1000);
        } catch (err) {
            console.error("[RE-COST] Immediate Re-entry failed. Halting leg completely.", err);
            newLeg.state = "COMPLETED";
            newLeg.exited = true;
        }
    } else if (leg.leg.lazy_leg_enabled && leg.leg.lazy_leg) {
        addStrategyLog(strategy.id, `Lazy Leg triggered after ${leg.instrument?.symbol || "leg"} stop-out. Initializing lazy leg...`, "INFO");

        const newLeg = {
            leg: { ...leg.leg.lazy_leg }, // The nested configuration
            instrument: null,
            orderId: null,
            uniqueOrderId: null,
            state: "WAITING_FOR_LAZY",
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: null,
            last_tick_price: null,
            reentry_count: 0,
            original_traded_price: 0,
            base_otp: 0,
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
    } else {
        console.log(`[RE-COST/LAZY] Leg ${leg.instrument?.symbol} fully stopped out and completed.`);
    }
}

async function executeStrategy(strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;

    const { config } = strategy;
    addStrategyLog(strategyId, `Strategy Execution started. Waiting for Entry Time ${config.entry_time}...`, "INFO");

    // Check loop
    const interval = setInterval(async () => {
        if (strategy.isProcessing) return;
        strategy.isProcessing = true;

        // Counter for regular DB persistence (every 30 seconds)
        strategy.persistenceTicks = (strategy.persistenceTicks || 0) + 1;

        try {
            const currentTime = getISTTime();

            if (strategy.status === "WAITING" && currentTime >= config.entry_time) {
                if (strategy.entryAttempted) {
                    return;
                }
                strategy.entryAttempted = true;
                // console.log(`Entry time reached for ${strategyId}`);
                try {
                    // 1. Get Spot Price to identify ATM Strike
                    let indexToken, indexExchange;
                    if (config.index === "NIFTY") {
                        indexToken = "99926000";
                        indexExchange = "NSE";
                    } else if (config.index === "BANKNIFTY") {
                        indexToken = "99926009";
                        indexExchange = "NSE";
                    } else if (config.index === "FINNIFTY") {
                        indexToken = "99926037";
                        indexExchange = "NSE";
                    } else if (config.index === "SENSEX") {
                        indexToken = "99919000";
                        indexExchange = "BSE";
                    }

                    // console.log(`Fetching LTP for ${config.index} (${indexExchange}:${indexToken})...`);
                    const ltpRes = await marketService.getLTP({
                        exchange: indexExchange,
                        symboltoken: indexToken,
                        connectionId: config.connectionId // PASS AUTH ALONG
                    });

                    if (ltpRes.status && ltpRes.data && ltpRes.data.fetched && ltpRes.data.fetched.length > 0) {
                        const spotPrice = ltpRes.data.fetched[0].ltp;
                        // console.log(`Spot Price for ${config.index}: ${spotPrice}`);
                        addStrategyLog(strategyId, `Entry condition met. Spot Price for ${config.index}: ₹${spotPrice}. Identifying strikes...`, "INFO");
                        const legs = config.legs || [];
                        const resolvedLegs = [];
                        for (const leg of legs) {
                            let targetInstrument = null;
                            if (leg.strike_criteria === 'CLOSEST_PREMIUM') {
                                console.log(`Searching closest premium for ${leg.option_type} @ ₹${leg.premium}`);
                                targetInstrument = await findClosestPremiumInstrument(config.index, leg.option_type, leg.premium, config.connectionId);
                            } else {
                                const { atmStrike, targetStrike, strikeLabel } = getLegStrikeSelection({
                                    index: config.index,
                                    option_type: leg.option_type,
                                    strike: leg.strike,
                                    spotPrice
                                });
                                // console.log(`Execution Search: Index=${config.index}, Spot=${spotPrice}, ATM=${atmStrike}, Selected=${strikeLabel}, TargetStrike=${targetStrike}, Type=${leg.option_type}`);
                                addStrategyLog(strategyId, `Leg ${resolvedLegs.length + 1}: Selecting ${strikeLabel} (${leg.option_type}) at Strike ${targetStrike}.`, "INFO");
                                targetInstrument = await findOptionInstrument(config.index, leg.option_type, targetStrike);
                                if (!targetInstrument) {
                                    throw new Error(`Could not find ${leg.option_type} instrument for ${strikeLabel}`);
                                }
                            }
                            resolvedLegs.push({ leg, instrument: targetInstrument });
                        }
                        strategy.legs = []; // Initialize for rollback visibility

                        const placedLegs = await Promise.all(resolvedLegs.map(async (item, idx) => {
                            let finalPrice = (config.price || "0").toString();
                            let orderData = null;
                            const isSimpleMntm = item.leg.simple_mntm_enabled === true;
                            let legState = "ACTIVE";
                            let instLtp = 0;

                            // 1. Fetch current price for either Limit calculation or Simple Mntm snapshot
                            try {
                                const instLtpRes = await marketService.getLTP({
                                    exchange: item.instrument.exch_seg,
                                    symboltoken: item.instrument.token,
                                    connectionId: config.connectionId
                                });
                                if (instLtpRes.status && instLtpRes.data?.fetched?.[0]) {
                                    instLtp = instLtpRes.data.fetched[0].ltp;
                                }
                            } catch (err) {
                                console.error(`Error fetching LTP for ${item.instrument.symbol}:`, err);
                            }

                            if (isSimpleMntm) {
                                // SIMPLE MOMENTUM ENTRY LOGIC
                                const mntmMode = item.leg.simple_mntm_mode || "SIMPLE_PLUS_PCT";
                                const mntmVal = parseFloat(item.leg.simple_mntm_value || 0);
                                let mntmTarget = instLtp;

                                if (mntmMode === "SIMPLE_PLUS_PCT") mntmTarget = instLtp + (instLtp * mntmVal / 100);
                                else if (mntmMode === "SIMPLE_PLUS_PTS") mntmTarget = instLtp + mntmVal;
                                else if (mntmMode === "SIMPLE_MINUS_PCT") mntmTarget = instLtp - (instLtp * mntmVal / 100);
                                else if (mntmMode === "SIMPLE_MINUS_PTS") mntmTarget = instLtp - mntmVal;

                                const roundedMntmTarget = roundToTick(mntmTarget);
                                const offset = parseFloat(config.entry_limit_offset || 0);

                                if (config.is_paper_trading) {
                                    // Paper: We wait in our code loop
                                    legState = "WAITING_FOR_SIMPLE_MNTM";
                                    addStrategyLog(strategyId, `[PAPER] Simple Mntm enabled for ${item.instrument.symbol}. Snapshot: ₹${instLtp}. Waiting for Target: ₹${roundedMntmTarget}...`, "INFO");
                                    orderData = {
                                        orderid: `V-SIMPLE-${Date.now()}`,
                                        uniqueorderid: `VU-SIMPLE-${Date.now()}`,
                                        mntmTargetPrice: roundedMntmTarget,
                                        baseOtp: instLtp
                                    };
                                } else {
                                    // Live: Send the "Universal Rule" resolved order to Broker
                                    const { variety, ordertype, price, triggerprice } = resolveUniversalOrderParams({
                                        targetPrice: roundedMntmTarget,
                                        currentLtp: instLtp,
                                        side: item.leg.side,
                                        offset
                                    });

                                    addStrategyLog(strategyId, `[LIVE] Simple Mntm: Snapshot ₹${instLtp}. Target ₹${roundedMntmTarget}. Placing ${variety} ${ordertype} at ${price}...`, "INFO");

                                    orderData = await placeOrder(
                                        {
                                            ...config,
                                            variety,
                                            ordertype,
                                            side: item.leg.side,
                                            lots: item.leg.lots,
                                            price,
                                            triggerprice
                                        },
                                        item.instrument,
                                        config.connectionId
                                    );
                                    legState = "WAITING_FOR_FILL"; // Wait for broker fill notification
                                }
                            } else {
                                // STANDARD ENTRY LOGIC
                                if (config.ordertype === 'LIMIT') {
                                    const offset = parseFloat(config.entry_limit_offset || 0);
                                    if (item.leg.side === "BUY") {
                                        finalPrice = roundToTick(instLtp + offset).toString();
                                    } else {
                                        finalPrice = roundToTick(instLtp - offset).toString();
                                    }
                                }

                                orderData = await placeOrder(
                                    {
                                        ...config,
                                        variety: config.variety === "STOPLOSS" ? "NORMAL" : config.variety,
                                        side: item.leg.side,
                                        lots: item.leg.lots,
                                        price: finalPrice
                                    },
                                    item.instrument,
                                    config.connectionId
                                );
                                addStrategyLog(strategyId, `Placed ${item.leg.side} order for ${item.instrument.symbol} (Qty: ${item.leg.lots * (parseInt(item.instrument.lotsize) || 1)}).`, "INFO");
                                legState = "ACTIVE";
                            }

                            const leg = {
                                ...item,
                                orderId: orderData.orderid,
                                uniqueOrderId: orderData.uniqueorderid,
                                mntmTargetPrice: orderData.mntmTargetPrice,
                                baseOtp: orderData.baseOtp || instLtp,
                                simpleMntmEnabled: isSimpleMntm,
                                legIndex: idx,
                                state: legState,
                                original_traded_price: parseFloat(finalPrice) || 0,
                                base_otp: parseFloat(finalPrice) || 0,
                                recost_trigger_price: null,
                                reentry_count: 0,
                                last_tick_price: null,
                                bookedPnlPoints: 0,
                                bookedPnlRupees: 0,
                                currentActivePnlPoints: 0,
                                currentActivePnlRupees: 0,
                                entryPrice: null,
                                currentLtp: null,
                                pnlPercent: 0,
                                pnlPoints: 0,
                                pnlRupees: 0,
                                slOrderId: null,
                                slUniqueOrderId: null,
                                slTriggerPrice: null,
                                slLimitPrice: null
                            };

                            // RECORD IT IMMEDIATELY for rollback visibility if another leg fails placement
                            strategy.legs.push(leg);
                            return leg;
                        }));

                        // Fetch entry fill prices and place stoploss exit orders parallelly
                        await Promise.all(placedLegs.map(async (leg) => {
                            if (leg.uniqueOrderId) {
                                // Skip fill price detection if waiting for Simple Mntm crossing in Paper
                                if (leg.state === "WAITING_FOR_SIMPLE_MNTM") return;

                                const fillPrice = await waitForOrderFillPrice(
                                    leg.uniqueOrderId,
                                    config.connectionId,
                                    config.is_paper_trading === true,
                                    leg.instrument,
                                    60000,
                                    2000,
                                    { /* paperConfig */
                                        side: leg.leg.side,
                                        ordertype: config.ordertype,
                                        price: parseFloat(leg.original_traded_price || config.price || 0),
                                        triggerprice: parseFloat(leg.mntmTargetPrice || config.triggerprice || 0)
                                    }
                                );
                                if (fillPrice) {
                                    leg.entryPrice = fillPrice;
                                    leg.entryTime = getISTTime();
                                    leg.original_traded_price = fillPrice;
                                    leg.base_otp = fillPrice;
                                    leg.peakPrice = fillPrice; // Initialize old TSL Peak
                                    leg.tslReferencePrice = fillPrice; // Initialize step-based TSL anchor
                                    addStrategyLog(strategyId, `${leg.instrument.symbol} order filled at ₹${fillPrice}.`, "INFO");
                                } else {
                                    const optLtpRes = await marketService.getLTP({
                                        exchange: leg.instrument.exch_seg,
                                        symboltoken: leg.instrument.token,
                                        connectionId: config.connectionId
                                    });
                                    if (optLtpRes.status && optLtpRes.data?.fetched?.[0]) {
                                        leg.entryPrice = optLtpRes.data.fetched[0].ltp;
                                        leg.entryTime = getISTTime();
                                        leg.original_traded_price = leg.entryPrice;
                                        leg.base_otp = leg.entryPrice;
                                        leg.peakPrice = leg.entryPrice; // Initialize old TSL Peak
                                        leg.tslReferencePrice = leg.entryPrice; // Initialize step-based TSL anchor
                                        addStrategyLog(strategyId, `Warning: Could not detect fill price for ${leg.instrument.symbol}. Using current LTP: ₹${leg.entryPrice}.`, "ERROR");
                                    }
                                }
                            }

                            if (config.variety === "STOPLOSS" && leg.entryPrice) {
                                const slOrder = await placeStopLossWithRetry({
                                    baseConfig: config,
                                    legSide: leg.leg.side,
                                    entryPrice: leg.entryPrice,
                                    instrument: leg.instrument,
                                    lots: leg.leg.lots,
                                    slType: leg.leg.sl_type || "PERCENTAGE",
                                    slValue: leg.leg.stop_loss,
                                    slLimitMargin: config.entry_limit_offset,
                                    connectionId: config.connectionId
                                });
                                const prices = computeStopLossExitPrices(
                                    leg.entryPrice,
                                    leg.leg.side,
                                    leg.leg.sl_type || "PERCENTAGE",
                                    leg.leg.stop_loss,
                                    config.entry_limit_offset
                                );

                                if (slOrder?.orderid) {
                                    leg.slOrderId = slOrder.orderid;
                                    leg.slUniqueOrderId = slOrder.uniqueorderid;
                                } else {
                                    addStrategyLog(strategyId, `[FALLBACK] Initializing virtual SL monitoring for unprotected leg ${leg.instrument.symbol}.`, "WARNING");
                                }

                                leg.slTriggerPrice = prices?.trigger || null;
                                leg.initialSlTriggerPrice = prices?.trigger || null;
                                leg.slLimitPrice = prices?.limit || null;
                            }
                        }));

                        strategy.status = "IN_POSITION";
                        // strategy.legs is already populated via push() in the placement loop

                        updateStrategyInMemory(strategyId, {
                            status: "IN_POSITION",
                            order_id: strategy.legs.map(l => l.orderId),
                            entry_price: strategy.legs.map(l => l.entryPrice),
                            instrument: strategy.legs.map(l => l.instrument)
                        });

                        // console.log(`Strategy ${strategyId} in position: ${strategy.legs.map(l => l.instrument.symbol).join(", ")}`);
                    } else {
                        console.error(`[${strategyId}] Failed to fetch Spot Price for entry. API Response:`, JSON.stringify(ltpRes));
                        strategy.entryAttempted = false; // allow retry next tick
                    }
                } catch (err) {
                    console.error(`[${strategyId}] Execution failed:`, err.message);

                    // ROLLBACK: If any legs were partially placed, exit them immediately for safety
                    if (strategy.legs && strategy.legs.length > 0) {
                        console.warn(`[${strategyId}] Partial entry detected (${strategy.legs.length} legs). Initiating emergency rollback...`);
                        try {
                            // Prepare state for squareOff call
                            strategy.status = "IN_POSITION";
                            strategy.exitAttempted = false;

                            // squareOffStrategy will handle SL cancellation and exit orders 
                            // (robust placeExitOrder will handle cancellation of pending entry orders)
                            await squareOffStrategy(strategyId);
                            console.log(`[${strategyId}] Safely rolled back partial entries.`);
                        } catch (rollbackErr) {
                            console.error(`[${strategyId}] Emergency rollback failed:`, rollbackErr.message);
                        }
                    }

                    strategy.status = "FAILED";
                    strategy.error = err.message;
                    updateStrategyInMemory(strategyId, { status: "FAILED", error: err.message });
                    clearInterval(interval);
                }
            }

            // Monitoring for Stop Loss or Exit Time
            if (strategy.status === "IN_POSITION" && strategy.legs?.length) {
                try {
                    const activeLegs = strategy.legs.filter(leg => !(leg.exited && !["WAITING_FOR_RECOST", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY"].includes(leg.state)));

                    if (activeLegs.length > 0) {
                        // Using centralized globalLtpMap updated by the singleton fetcher
                        const ltpMap = globalLtpMap;

                        for (const leg of activeLegs) {
                            // 0. RE-ASAP Logic: Re-select strike and entry price ASAP
                            if (leg.state === "WAITING_FOR_RE_ASAP") {
                                try {
                                    let indexToken = "99926000", indexExchange = "NSE";
                                    if (config.index === "BANKNIFTY") indexToken = "99926009";
                                    else if (config.index === "FINNIFTY") indexToken = "99926037";
                                    else if (config.index === "SENSEX") { indexToken = "99919000"; indexExchange = "BSE"; }

                                    const spotRes = await marketService.getLTP({ exchange: indexExchange, symboltoken: indexToken, connectionId: config.connectionId });
                                    if (!spotRes.status || !spotRes.data?.fetched?.[0]) continue;
                                    const spotPrice = spotRes.data.fetched[0].ltp;

                                    let targetInstrument = null;
                                    if (leg.leg.strike_criteria === 'CLOSEST_PREMIUM') {
                                        targetInstrument = await findClosestPremiumInstrument(config.index, leg.leg.option_type, leg.leg.premium, config.connectionId);
                                    } else {
                                        const { targetStrike } = getLegStrikeSelection({ index: config.index, option_type: leg.leg.option_type, strike: leg.leg.strike, spotPrice });
                                        targetInstrument = await findOptionInstrument(config.index, leg.leg.option_type, targetStrike);
                                    }

                                    if (!targetInstrument) {
                                        addStrategyLog(strategyId, `RE-ASAP: Could not find instrument for ${leg.leg.option_type}. Retrying...`, "ERROR");
                                        continue;
                                    }

                                    leg.instrument = targetInstrument;
                                    const instLtpRes = await marketService.getLTP({ exchange: targetInstrument.exch_seg, symboltoken: targetInstrument.token, connectionId: config.connectionId });
                                    const instLtp = instLtpRes.data?.fetched?.[0]?.ltp || 0;

                                    if (leg.leg.simple_mntm_enabled) {
                                        const mntmMode = leg.leg.simple_mntm_mode || "SIMPLE_PLUS_PCT";
                                        const mntmVal = parseFloat(leg.leg.simple_mntm_value || 0);
                                        let target = instLtp;
                                        if (mntmMode === "SIMPLE_PLUS_PCT") target = instLtp + (instLtp * mntmVal / 100);
                                        else if (mntmMode === "SIMPLE_PLUS_PTS") target = instLtp + mntmVal;
                                        else if (mntmMode === "SIMPLE_MINUS_PCT") target = instLtp - (instLtp * mntmVal / 100);
                                        else if (mntmMode === "SIMPLE_MINUS_PTS") target = instLtp - mntmVal;

                                        leg.mntmTargetPrice = roundToTick(target);
                                        leg.baseOtp = instLtp;
                                        leg.state = "WAITING_FOR_SIMPLE_MNTM";
                                        addStrategyLog(strategyId, `[RE-ASAP] ${targetInstrument.symbol} re-entry #${leg.reentry_count} waiting for Momentum @ ₹${leg.mntmTargetPrice}`, "INFO");
                                    } else {
                                        if (config.is_paper_trading) {
                                            leg.entryPrice = instLtp;
                                            leg.entryTime = getISTTime();
                                            leg.original_traded_price = instLtp;
                                            leg.state = "ACTIVE";
                                            leg.peakPrice = instLtp; // Initialize TSL Peak
                                            leg.tslReferencePrice = instLtp; // Initialize step-based TSL anchor
                                            addStrategyLog(strategyId, `[RE-ASAP PAPER] ${targetInstrument.symbol} re-entered at ₹${instLtp}`, "INFO");
                                            if (config.variety === "STOPLOSS") {
                                                const slType = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                                                const slVal = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : (leg.leg.stop_loss || 0);
                                                const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, slType, slVal, config.entry_limit_offset);
                                                leg.slTriggerPrice = prices?.trigger;
                                                leg.slLimitPrice = prices?.limit;
                                            }
                                        } else {
                                            const offset = parseFloat(config.entry_limit_offset || 0);
                                            const params = resolveUniversalOrderParams({ targetPrice: instLtp, currentLtp: instLtp, side: leg.leg.side, offset });
                                            const orderRes = await placeOrder({ ...config, ...params, side: leg.leg.side, lots: leg.leg.lots }, targetInstrument, config.connectionId);
                                            leg.orderId = orderRes.orderid;
                                            leg.uniqueOrderId = orderRes.uniqueorderid;
                                            leg.state = "WAITING_FOR_FILL";
                                            addStrategyLog(strategyId, `[RE-ASAP LIVE] ${targetInstrument.symbol} re-entry #${leg.reentry_count} placed: ${params.ordertype} @ ${params.price}`, "INFO");
                                        }
                                    }
                                } catch (e) {
                                    console.error("RE-ASAP Tick Error", e);
                                }
                                continue;
                            }

                            // 0b. Lazy Leg Logic: Resolve and place the next nested leg
                            if (leg.state === "WAITING_FOR_LAZY") {
                                try {
                                    let indexToken = "99926000", indexExchange = "NSE";
                                    if (config.index === "BANKNIFTY") indexToken = "99926009";
                                    else if (config.index === "FINNIFTY") indexToken = "99926037";
                                    else if (config.index === "SENSEX") { indexToken = "99919000"; indexExchange = "BSE"; }

                                    const spotRes = await marketService.getLTP({ exchange: indexExchange, symboltoken: indexToken, connectionId: config.connectionId });
                                    if (!spotRes.status || !spotRes.data?.fetched?.[0]) continue;
                                    const spotPrice = spotRes.data.fetched[0].ltp;

                                    let targetInstrument = null;
                                    if (leg.leg.strike_criteria === 'CLOSEST_PREMIUM') {
                                        targetInstrument = await findClosestPremiumInstrument(config.index, leg.leg.option_type, leg.leg.premium, config.connectionId);
                                    } else {
                                        const { targetStrike } = getLegStrikeSelection({ index: config.index, option_type: leg.leg.option_type, strike: leg.leg.strike, spotPrice });
                                        targetInstrument = await findOptionInstrument(config.index, leg.leg.option_type, targetStrike);
                                    }

                                    if (!targetInstrument) {
                                        addStrategyLog(strategyId, `Lazy Leg: Could not find instrument for ${leg.leg.option_type}. Retrying...`, "ERROR");
                                        continue;
                                    }

                                    leg.instrument = targetInstrument;
                                    const instLtpRes = await marketService.getLTP({ exchange: targetInstrument.exch_seg, symboltoken: targetInstrument.token, connectionId: config.connectionId });
                                    const instLtp = instLtpRes.data?.fetched?.[0]?.ltp || 0;

                                    if (leg.leg.simple_mntm_enabled) {
                                        const mntmMode = leg.leg.simple_mntm_mode || "SIMPLE_PLUS_PCT";
                                        const mntmVal = parseFloat(leg.leg.simple_mntm_value || 0);
                                        let target = instLtp;
                                        if (mntmMode === "SIMPLE_PLUS_PCT") target = instLtp + (instLtp * mntmVal / 100);
                                        else if (mntmMode === "SIMPLE_PLUS_PTS") target = instLtp + mntmVal;
                                        else if (mntmMode === "SIMPLE_MINUS_PCT") target = instLtp - (instLtp * mntmVal / 100);
                                        else if (mntmMode === "SIMPLE_MINUS_PTS") target = instLtp - mntmVal;

                                        leg.mntmTargetPrice = roundToTick(target);
                                        leg.baseOtp = instLtp;
                                        leg.state = "WAITING_FOR_SIMPLE_MNTM";
                                        addStrategyLog(strategyId, `[LAZY LEG] ${targetInstrument.symbol} waiting for Momentum @ ₹${leg.mntmTargetPrice}`, "INFO");
                                    } else {
                                        if (config.is_paper_trading) {
                                            leg.entryPrice = instLtp;
                                            leg.entryTime = getISTTime();
                                            leg.original_traded_price = instLtp;
                                            leg.state = "ACTIVE";
                                            leg.peakPrice = instLtp; // Initialize old TSL Peak
                                            leg.tslReferencePrice = instLtp; // Initialize step-based TSL anchor
                                            addStrategyLog(strategyId, `[LAZY LEG PAPER] ${targetInstrument.symbol} entered at ₹${instLtp}`, "INFO");
                                            if (config.variety === "STOPLOSS") {
                                                const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss || 0, config.entry_limit_offset);
                                                leg.slTriggerPrice = prices?.trigger;
                                                leg.slLimitPrice = prices?.limit;
                                            }
                                        } else {
                                            const offset = parseFloat(config.entry_limit_offset || 0);
                                            const params = resolveUniversalOrderParams({ targetPrice: instLtp, currentLtp: instLtp, side: leg.leg.side, offset });
                                            const orderRes = await placeOrder({ ...config, ...params, side: leg.leg.side, lots: leg.leg.lots }, targetInstrument, config.connectionId);
                                            leg.orderId = orderRes.orderid;
                                            leg.uniqueOrderId = orderRes.uniqueorderid;
                                            leg.state = "WAITING_FOR_FILL";
                                            addStrategyLog(strategyId, `[LAZY LEG LIVE] ${targetInstrument.symbol} placed: ${params.ordertype} @ ${params.price}`, "INFO");
                                        }
                                    }
                                } catch (e) {
                                    console.error("Lazy Leg Tick Error", e);
                                }
                                continue;
                            }
                            const exch = leg.instrument.exch_seg;
                            const token = leg.instrument.token;
                            const tickPrice = ltpMap[`${exch}_${token}`];

                            if (tickPrice !== undefined) {
                                leg.currentLtp = tickPrice;

                                // 0. SIMPLE MOMENTUM ENTRY CROSSING logic (Paper Only)
                                if (leg.state === "WAITING_FOR_SIMPLE_MNTM" && leg.last_tick_price !== null) {
                                    const currentTick = leg.currentLtp;
                                    const prevTick = leg.last_tick_price;
                                    const target = leg.mntmTargetPrice;
                                    const mode = leg.leg.simple_mntm_mode || "SIMPLE_PLUS_PCT";

                                    let mntmHit = false;
                                    if (mode.includes("PLUS")) {
                                        if (prevTick <= target && currentTick >= target) mntmHit = true;
                                    } else {
                                        if (prevTick >= target && currentTick <= target) mntmHit = true;
                                    }

                                    if (mntmHit) {
                                        console.log(`[SIMPLE MNTM HIT] Target ₹${target} reached for ${leg.instrument.symbol}. Simulating Entry...`);
                                        addStrategyLog(strategyId, `Simple Momentum Target Reached: ₹${target} for ${leg.instrument.symbol}. Entry triggered.`, "INFO");

                                        leg.entryPrice = target;
                                        leg.entryTime = getISTTime();
                                        leg.original_traded_price = target;
                                        leg.state = "ACTIVE";

                                        // Now place SL if needed
                                        if (config.variety === "STOPLOSS" && leg.entryPrice) {
                                            const slOrder = await placeStopLossWithRetry({
                                                baseConfig: config,
                                                legSide: leg.leg.side,
                                                entryPrice: leg.entryPrice,
                                                instrument: leg.instrument,
                                                lots: leg.leg.lots,
                                                slType: leg.leg.sl_type || "PERCENTAGE",
                                                slValue: leg.leg.stop_loss,
                                                slLimitMargin: config.entry_limit_offset,
                                                connectionId: config.connectionId,
                                                strategyId: strategyId
                                            });

                                            const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss, config.entry_limit_offset);
                                            if (slOrder?.orderid) {
                                                leg.slOrderId = slOrder.orderid;
                                                leg.slUniqueOrderId = slOrder.uniqueorderid;
                                            } else {
                                                addStrategyLog(strategyId, `[FALLBACK] Initializing virtual SL monitoring for ${leg.instrument.symbol} (Momentum Entry).`, "WARNING");
                                            }
                                            leg.slTriggerPrice = prices?.trigger || null;
                                            leg.initialSlTriggerPrice = prices?.trigger || null;
                                            leg.slLimitPrice = prices?.limit || null;
                                        }
                                    }
                                }

                                // 1. RE-COST Engines: Crossing Logic
                                if (leg.state === "WAITING_FOR_MNTM" && leg.last_tick_price !== null) {
                                    const currentTick = leg.currentLtp;
                                    const prevTick = leg.last_tick_price;
                                    const rtp = leg.recost_trigger_price;

                                    let triggerReEntry = false;

                                    // RECOST Crossing Logic: Trigger based on direction (PLUS = Upward Hit, MINUS = Downward Hit)
                                    if (leg.leg.recost_mode.includes("PLUS")) {
                                        if (prevTick <= rtp && currentTick >= rtp) triggerReEntry = true;
                                    } else {
                                        if (prevTick >= rtp && currentTick <= rtp) triggerReEntry = true;
                                    }

                                    if (triggerReEntry) {
                                        console.log(`[RE-COST MNTM] Condition met for ${leg.instrument.symbol} at ${currentTick}! Target RTP (${rtp}) Reached. Calculating MTP...`);
                                        addStrategyLog(strategyId, `Momentum Hit for ${leg.instrument.symbol}: Price ₹${currentTick} crossed RTP ₹${rtp}. Re-entering...`, "INFO");
                                        leg.reentry_count++;
                                        leg.state = "ACTIVE";

                                        // Calculate MTP (Mntm Trigger Price) from RTP
                                        const mntmMode = leg.leg.recost_mntm_mode || "RECOST_PLUS_PCT";
                                        const mntmVal = parseFloat(leg.leg.recost_mntm_value || 0);
                                        let mtp = rtp;

                                        if (mntmMode === "RECOST_PLUS_PCT") mtp = rtp + (rtp * mntmVal / 100);
                                        else if (mntmMode === "RECOST_PLUS_PTS") mtp = rtp + mntmVal;
                                        else if (mntmMode === "RECOST_MINUS_PCT") mtp = rtp - (rtp * mntmVal / 100);
                                        else if (mntmMode === "RECOST_MINUS_PTS") mtp = rtp - mntmVal;

                                        const roundedMtp = roundToTick(mtp);

                                        // Now determine Stoploss vs Limit exactly like the immediate mode
                                        let variety = config.variety || "NORMAL";
                                        let ordertype = config.ordertype || "LIMIT";
                                        const offset = parseFloat(config.entry_limit_offset || 0);
                                        let finalPriceStr = roundedMtp.toString();
                                        let triggerPriceStr = roundedMtp.toString();
                                        const side = leg.leg.side;

                                        if (side === "SELL") {
                                            if (roundedMtp < currentTick) {
                                                variety = "STOPLOSS";
                                                ordertype = "STOPLOSS_LIMIT";
                                                finalPriceStr = roundToTick(roundedMtp - offset).toString();
                                            } else {
                                                variety = "NORMAL";
                                                ordertype = "LIMIT";
                                                finalPriceStr = roundToTick(roundedMtp - offset).toString();
                                            }
                                        } else if (side === "BUY") {
                                            if (roundedMtp > currentTick) {
                                                variety = "STOPLOSS";
                                                ordertype = "STOPLOSS_LIMIT";
                                                finalPriceStr = roundToTick(roundedMtp + offset).toString();
                                            } else {
                                                variety = "NORMAL";
                                                ordertype = "LIMIT";
                                                finalPriceStr = roundToTick(roundedMtp + offset).toString();
                                            }
                                        }

                                        try {
                                            console.log(`[RE-COST MNTM] Firing Order for ${leg.instrument.symbol}. MTP=${roundedMtp}, LTP=${currentTick}, Var/Type=${variety}/${ordertype}`);
                                            const reEntryOrder = await placeOrder(
                                                {
                                                    ...config,
                                                    side: side,
                                                    variety: variety,
                                                    ordertype: ordertype,
                                                    price: finalPriceStr,
                                                    triggerprice: triggerPriceStr,
                                                    lots: leg.leg.lots
                                                },
                                                leg.instrument,
                                                config.connectionId
                                            );

                                            leg.orderId = reEntryOrder.orderid;
                                            leg.uniqueOrderId = reEntryOrder.uniqueorderid;
                                            leg.mtp = roundedMtp;
                                            leg.rtp = rtp;

                                            // Wait for fill cleanly in background (allow up to 8 hours for Limits to cross)
                                            setTimeout(async () => {
                                                try {
                                                    const fill = await waitForOrderFillPrice(
                                                        leg.uniqueOrderId,
                                                        config.connectionId,
                                                        config.is_paper_trading === true,
                                                        leg.instrument,
                                                        28800000,
                                                        1000,
                                                        {
                                                            side: side,
                                                            ordertype: ordertype,
                                                            price: parseFloat(finalPriceStr || 0),
                                                            triggerprice: parseFloat(triggerPriceStr || 0)
                                                        }
                                                    );
                                                    leg.entryPrice = fill || currentTick;
                                                    leg.entryTime = getISTTime();
                                                    leg.original_traded_price = leg.entryPrice;
                                                    leg.peakPrice = leg.entryPrice;
                                                } catch (e) {
                                                    leg.entryPrice = currentTick;
                                                    leg.entryTime = getISTTime();
                                                    leg.peakPrice = leg.entryPrice;
                                                }

                                                // Redeploy exchange SL if needed
                                                if (config.variety === "STOPLOSS" && leg.entryPrice) {
                                                    const activeSlType = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                                                    const activeSlValue = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : leg.leg.stop_loss;

                                                    const slOrder = await placeStopLossWithRetry({
                                                        baseConfig: config,
                                                        legSide: leg.leg.side,
                                                        entryPrice: leg.entryPrice,
                                                        instrument: leg.instrument,
                                                        lots: leg.leg.lots,
                                                        slType: activeSlType,
                                                        slValue: activeSlValue,
                                                        slLimitMargin: config.entry_limit_offset,
                                                        connectionId: config.connectionId,
                                                        strategyId: strategyId
                                                    });

                                                    const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, activeSlType, activeSlValue, config.entry_limit_offset);
                                                    if (slOrder?.orderid) {
                                                        leg.slOrderId = slOrder.orderid;
                                                        leg.slUniqueOrderId = slOrder.uniqueorderid;
                                                    } else {
                                                        addStrategyLog(strategyId, `[FALLBACK] Initializing virtual SL monitoring for ${leg.instrument.symbol} (Re-Cost Entry).`, "WARNING");
                                                    }
                                                    leg.slTriggerPrice = prices?.trigger;
                                                    leg.initialSlTriggerPrice = prices?.trigger;
                                                    leg.slLimitPrice = prices?.limit;
                                                    leg.exchangeSlProcessed = false;
                                                }
                                            }, 1000);
                                        } catch (err) {
                                            console.error("[RE-COST MNTM] Momentum Re-entry failed. Halting leg completely.", err);
                                            leg.state = "COMPLETED";
                                            leg.exited = true;
                                        }
                                    }
                                }

                                leg.last_tick_price = leg.currentLtp;

                                if (leg.entryPrice && leg.state === "ACTIVE") {
                                    if (leg.peakPrice === undefined || leg.peakPrice === null) {
                                        leg.peakPrice = leg.entryPrice;
                                    }
                                    if (leg.leg.side === "BUY") {
                                        if (leg.currentLtp > leg.peakPrice) leg.peakPrice = leg.currentLtp;
                                    } else {
                                        if (leg.currentLtp < leg.peakPrice) leg.peakPrice = leg.currentLtp;
                                    }

                                    const pnlPoints = leg.leg.side === "BUY"
                                        ? (leg.currentLtp - leg.entryPrice)
                                        : (leg.entryPrice - leg.currentLtp);

                                    leg.currentActivePnlPoints = pnlPoints;
                                    const quantity = leg.leg.lots * parseInt(leg.instrument.lotsize || 1);
                                    leg.currentActivePnlRupees = pnlPoints * quantity;

                                    leg.pnlPercent = ((leg.bookedPnlPoints || 0) + pnlPoints) / leg.original_traded_price * 100;
                                    leg.currentActivePnlPercent = (pnlPoints / leg.entryPrice) * 100;
                                    leg.pnlPoints = (leg.bookedPnlPoints || 0) + leg.currentActivePnlPoints;
                                    leg.pnlRupees = (leg.bookedPnlRupees || 0) + leg.currentActivePnlRupees;
                                }
                            }
                        }

                        // Total PnL in Rupees
                        const totalPnlRupees = strategy.legs.reduce((sum, l) => sum + (l.pnlRupees || 0), 0);
                        strategy.totalPnlRupees = totalPnlRupees;

                        // Calculate weighted overall return % based on cumulative capital deployment
                        const totalOriginalValue = strategy.legs.reduce((sum, l) => {
                            if (!l.original_traded_price) return sum;
                            const quantity = (l.leg?.lots || 0) * parseInt(l.instrument?.lotsize || 1);
                            return sum + (l.original_traded_price * quantity);
                        }, 0);

                        const avgPnl = totalOriginalValue > 0 ? (totalPnlRupees / totalOriginalValue) * 100 : 0;
                        strategy.pnlPercent = avgPnl;
                        strategy.totalOriginalValue = totalOriginalValue;

                        // Check Overall Stop Loss
                        const slType = config.overall_sl_type || "PERCENTAGE";
                        const slValue = parseFloat(config.overall_sl_value || 0);

                        let isOverallSlHit = false;
                        let slReason = "";

                        if (slValue > 0) {
                            if (slType === "PERCENTAGE" && avgPnl <= -slValue) {
                                isOverallSlHit = true;
                                slReason = `Overall SL% (${slValue}%) hit`;
                            } else if (slType === "AMOUNT" && totalPnlRupees <= -slValue) {
                                isOverallSlHit = true;
                                slReason = `Overall SL₹ (₹${slValue}) hit`;
                            }
                        }

                        if (isOverallSlHit) {
                            if (strategy.exitAttempted) return;
                            strategy.exitAttempted = true;
                            console.log(`[${new Date().toISOString()}] ${slReason} for strategy ${strategyId}. Exiting remaining legs.`);

                            // Cancel any pending SL orders on exchange for active legs
                            if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
                                await Promise.all(strategy.legs.map(async (leg) => {
                                    if (!leg.exited && leg.slOrderId) {
                                        try {
                                            const api = await getAuthorizedInstance(config.connectionId);
                                            await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                                            console.log(`Cancelled SL order ${leg.slOrderId} for ${leg.instrument?.symbol || 'Unknown'} due to overall SL`);
                                        } catch (e) {
                                            console.error(`Failed to cancel SL order ${leg.slOrderId}:`, e.message);
                                        }
                                    }
                                }));
                            }

                            const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
                                if (leg.exited) return leg.exitOrderId;
                                return await placeExitOrder({
                                    config,
                                    leg,
                                    instrument: leg.instrument,
                                    exitType: "OVERALL_STOP_LOSS"
                                });
                            }));
                            strategy.status = "COMPLETED";
                            strategy.exitOrderId = exitOrders;
                            strategy.exitType = "OVERALL_STOP_LOSS";
                            addStrategyLog(strategyId, `SQUARING OFF due to Overall Stop Loss hit. Final PnL: ₹${totalPnlRupees.toFixed(2)} (${avgPnl.toFixed(2)}%).`, "CRITICAL");
                            updateStrategyInMemory(strategyId, {
                                status: "COMPLETED",
                                exit_order_id: strategy.exitOrderId,
                                exit_type: "OVERALL_STOP_LOSS",
                                final_pnl_percent: avgPnl,
                                totalPnlRupees: totalPnlRupees,
                                totalOriginalValue: strategy.totalOriginalValue,
                                legs: strategy.legs
                            });
                            clearInterval(interval);
                            return;
                        }

                        // Check Overall Target
                        const targetType = config.overall_target_type || "PERCENTAGE";
                        const targetValue = parseFloat(config.overall_target_value || 0);

                        let isOverallTargetHit = false;
                        let targetReason = "";

                        if (targetValue > 0) {
                            if (targetType === "PERCENTAGE" && avgPnl >= targetValue) {
                                isOverallTargetHit = true;
                                targetReason = `Overall Target% (${targetValue}%) hit`;
                            } else if (targetType === "AMOUNT" && totalPnlRupees >= targetValue) {
                                isOverallTargetHit = true;
                                targetReason = `Overall Target₹ (₹${targetValue}) hit`;
                            }
                        }

                        if (isOverallTargetHit) {
                            if (strategy.exitAttempted) return;
                            strategy.exitAttempted = true;
                            console.log(`[${new Date().toISOString()}] ${targetReason} for strategy ${strategyId}. Exiting remaining legs to book profits.`);

                            // Cancel any pending SL orders on exchange for active legs
                            if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
                                await Promise.all(strategy.legs.map(async (leg) => {
                                    if (!leg.exited && leg.slOrderId) {
                                        try {
                                            const api = await getAuthorizedInstance(config.connectionId);
                                            await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                                            console.log(`Cancelled SL order ${leg.slOrderId} for ${leg.instrument?.symbol || 'Unknown'} due to overall target hit`);
                                        } catch (e) {
                                            console.error(`Failed to cancel SL order ${leg.slOrderId}:`, e.message);
                                        }
                                    }
                                }));
                            }

                            const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
                                if (leg.exited) return leg.exitOrderId;
                                return await placeExitOrder({
                                    config,
                                    leg,
                                    instrument: leg.instrument,
                                    exitType: "OVERALL_TARGET"
                                });
                            }));
                            strategy.status = "COMPLETED";
                            strategy.exitOrderId = exitOrders;
                            strategy.exitType = "OVERALL_TARGET";
                            addStrategyLog(strategyId, `SQUARING OFF due to Overall Target hit. Final PnL: ₹${totalPnlRupees.toFixed(2)} (${avgPnl.toFixed(2)}%).`, "SUCCESS");
                            updateStrategyInMemory(strategyId, {
                                status: "COMPLETED",
                                exit_order_id: strategy.exitOrderId,
                                exit_type: "OVERALL_TARGET",
                                final_pnl_percent: avgPnl,
                                totalPnlRupees: totalPnlRupees,
                                totalOriginalValue: strategy.totalOriginalValue,
                                legs: strategy.legs
                            });
                            clearInterval(interval);
                            return;
                        }

                        // Manual Check for TSL and Static SL
                        for (const leg of strategy.legs) {
                            if (leg.exited || leg.state === "WAITING_FOR_RECOST") continue;

                            let isHit = false;
                            let exitReason = "LEG_STOP_LOSS";

                            // 1. Evaluate Trailing Stop Loss mathematically (Step-based Tracking)
                            if (leg.leg.tsl_enabled && leg.tslReferencePrice !== undefined && leg.currentLtp !== null && leg.leg.tsl_value > 0 && leg.leg.tsl_trail > 0) {
                                const tslType = leg.leg.tsl_type || "PERCENTAGE";
                                const tslMove = parseFloat(leg.leg.tsl_value);
                                const tslTrail = parseFloat(leg.leg.tsl_trail);

                                let moveThreshold = tslMove;
                                let trailAmount = tslTrail;

                                if (tslType === "PERCENTAGE") {
                                    moveThreshold = leg.entryPrice * (tslMove / 100);
                                    trailAmount = leg.entryPrice * (tslTrail / 100);
                                } else if (tslType === "POINTS") {
                                    // User wants literal Option Premium Price Ticks.
                                    // A 50pt move means tracking exactly 50 points of price movement on the LTP.
                                    // A 10pt trail means moving the trigger specifically by exactly 10 absolute points.
                                    moveThreshold = tslMove;
                                    trailAmount = tslTrail;
                                }

                                let favorableMove = 0;
                                if (leg.leg.side === "BUY") {
                                    favorableMove = leg.currentLtp - leg.tslReferencePrice;
                                } else if (leg.leg.side === "SELL") {
                                    favorableMove = leg.tslReferencePrice - leg.currentLtp;
                                }

                                // Check if step condition matches
                                if (favorableMove >= moveThreshold) {
                                    const steps = Math.floor(favorableMove / moveThreshold);
                                    const totalTrail = steps * trailAmount;

                                    if (steps > 0) {
                                        const oldTrigger = leg.slTriggerPrice;
                                        let newTrigger = oldTrigger;

                                        if (leg.leg.side === "BUY") {
                                            newTrigger = oldTrigger + totalTrail;
                                        } else {
                                            newTrigger = oldTrigger - totalTrail;
                                        }

                                        // Ensure we don't accidentally trail backwards.
                                        // If oldTrigger is null (e.g., initial stop loss wasn't explicitly set), we bypass the strict direction check for the very first initialization.
                                        let isValidTrail = true;
                                        if (oldTrigger !== null && oldTrigger !== undefined) {
                                            isValidTrail = leg.leg.side === "BUY" ? newTrigger > oldTrigger : newTrigger < oldTrigger;
                                        }

                                        // We evaluate the validity of the trail, even if leg.slTriggerPrice isn't explicitly set yet (like in simple paper)
                                        if (isValidTrail) {
                                            const roundedTrigger = roundToTick(newTrigger);
                                            const newLimit = roundToTick(leg.leg.side === "BUY" ?
                                                roundedTrigger - parseFloat(config.entry_limit_offset || 0) :
                                                roundedTrigger + parseFloat(config.entry_limit_offset || 0));

                                            // Attempt Exchange Modify if needed (only for live & exchange SL mode)
                                            if (config.variety === "STOPLOSS" && !config.is_paper_trading && leg.slOrderId) {
                                                try {
                                                    const api = await getAuthorizedInstance(config.connectionId);
                                                    const modParams = {
                                                        variety: "STOPLOSS",
                                                        orderid: leg.slOrderId,
                                                        ordertype: "STOPLOSS_LIMIT",
                                                        producttype: config.producttype || "CARRYFORWARD",
                                                        duration: config.duration || "DAY",
                                                        price: newLimit.toString(),
                                                        quantity: leg.leg.lots.toString(),
                                                        tradingsymbol: leg.instrument.symbol,
                                                        symboltoken: leg.instrument.token,
                                                        exchange: leg.instrument.exch_seg,
                                                        triggerprice: roundedTrigger.toString(),
                                                    };

                                                    const res = await api.modifyOrder(modParams);
                                                    if (res && res.status) {
                                                        console.log(`[TSL] Exchange SL Modified for ${leg.instrument.symbol}. Trigger: ${oldTrigger} -> ${roundedTrigger}`);
                                                        console.log(`[TSL] Reason: LTP crossed ${leg.currentLtp} (Anchor was ${leg.tslReferencePrice})`);
                                                        addStrategyLog(strategyId, `TSL Step: Moved SL for ${leg.instrument.symbol} to ₹${roundedTrigger} (LTP: ${leg.currentLtp}, Anchor: ${leg.tslReferencePrice})`, "INFO");
                                                    }
                                                } catch (e) {
                                                    console.error(`[TSL] Failed to modify order ${leg.slOrderId} at exchange:`, e.message);
                                                }
                                            } else {
                                                // Paper Trading / Virtual Stop Loss update logging
                                                const paperPayload = {
                                                    variety: "STOPLOSS",
                                                    orderid: leg.slOrderId || "PAPER-SL-ORDER",
                                                    ordertype: "STOPLOSS_LIMIT",
                                                    price: newLimit.toString(),
                                                    quantity: leg.leg.lots.toString(),
                                                    triggerprice: roundedTrigger.toString(),
                                                };
                                                console.log(`\n[${new Date().toISOString()}] PAPER SL MODIFY:`, paperPayload);
                                                console.log(`[TSL Paper] Virtual SL Modified for ${leg.instrument.symbol}. Trigger: ${oldTrigger} -> ${roundedTrigger}`);
                                                console.log(`[TSL Paper] Reason: LTP crossed ${leg.currentLtp} (Anchor was ${leg.tslReferencePrice}) | PnL: ₹${leg.pnlRupees ? leg.pnlRupees.toFixed(2) : '0.00'}`);
                                                addStrategyLog(strategyId, `[PAPER TSL] Virtual SL moved to ₹${roundedTrigger} (LTP: ${leg.currentLtp}, Anchor: ${leg.tslReferencePrice})`, "INFO");
                                            }

                                            // Always update memory state regardless of mode
                                            leg.slTriggerPrice = roundedTrigger;
                                            leg.slLimitPrice = newLimit;

                                            // Step the reference price anchor so it resets for the NEXT step chunk calculation
                                            leg.tslReferencePrice = leg.leg.side === "BUY"
                                                ? leg.tslReferencePrice + (steps * moveThreshold)
                                                : leg.tslReferencePrice - (steps * moveThreshold);
                                        }
                                    }
                                }

                                // TSL evaluation mapping - if SL hits the local trailing values first
                                if (leg.slTriggerPrice) {
                                    if (leg.leg.side === "BUY" && leg.currentLtp <= leg.slTriggerPrice) {
                                        isHit = true;
                                        exitReason = "TRAILING_STOP_LOSS";
                                    } else if (leg.leg.side === "SELL" && leg.currentLtp >= leg.slTriggerPrice) {
                                        isHit = true;
                                        exitReason = "TRAILING_STOP_LOSS";
                                    }
                                }
                            }

                            // 2. Evaluate Static Stop Loss (if not already hit by TSL)
                            // Fallback: Also monitor manually if we are doing live STOPLOSS but the order failed (slOrderId is null)
                            if (!isHit && (config.variety !== "STOPLOSS" || config.is_paper_trading === true || !leg.slOrderId)) {
                                const isReentered = leg.reentry_count > 0;
                                const activeSlValue = isReentered && leg.leg.reentry_sl_enabled ? parseFloat(leg.leg.reentry_sl_value || 0) : parseFloat(leg.leg.stop_loss || 0);

                                if (activeSlValue > 0) {
                                    const activeSlType = isReentered && leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");

                                    if (activeSlType === "POINTS") {
                                        isHit = leg.currentActivePnlPoints <= -activeSlValue;
                                    } else {
                                        isHit = leg.currentActivePnlPercent <= -activeSlValue;
                                    }

                                    if (isHit) {
                                        exitReason = "LEG_STOP_LOSS";
                                    }

                                    // Initialize slTriggerPrice and initialSlTriggerPrice for display if not set
                                    if (leg.initialSlTriggerPrice === undefined || leg.initialSlTriggerPrice === null) {
                                        const prices = computeStopLossExitPrices(
                                            leg.entryPrice,
                                            leg.leg.side,
                                            activeSlType,
                                            activeSlValue,
                                            config.entry_limit_offset
                                        );
                                        if (prices) {
                                            leg.slTriggerPrice = prices.trigger;
                                            leg.initialSlTriggerPrice = prices.trigger;
                                            leg.slLimitPrice = prices.limit;
                                        }
                                    }
                                }
                            }

                            if (isHit) {
                                console.log(`[${new Date().toISOString()}] ${exitReason} hit for leg ${leg.instrument.symbol}: PnL=${leg.pnlPercent.toFixed(2)}%`);

                                // Clean up static Exchange SL order if we hit TSL (in case modify failed previously or it triggered locally first)
                                if (config.variety === "STOPLOSS" && !config.is_paper_trading && leg.slOrderId) {
                                    try {
                                        const api = await getAuthorizedInstance(config.connectionId);
                                        await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                                        console.log(`Cancelled Static SL order ${leg.slOrderId} for leg ${leg.instrument.symbol} due to ${exitReason}`);
                                    } catch (e) {
                                        console.error(`Failed to cancel static SL order ${leg.slOrderId} on trap:`, e.message);
                                    }
                                }

                                await placeExitOrder({
                                    config,
                                    leg,
                                    instrument: leg.instrument,
                                    exitType: exitReason
                                });
                                await handleLegStopOut(leg, exitReason, strategy);
                            }
                        }

                        // Real Stop Loss handling for variety="STOPLOSS" via API check
                        if (config.variety === "STOPLOSS" && config.is_paper_trading !== true) {
                            for (const leg of strategy.legs) {
                                if (leg.exited || leg.state === "WAITING_FOR_RECOST") continue;
                                if (leg.slUniqueOrderId && !leg.exchangeSlProcessed) {
                                    const isNearTrigger = leg.leg.side === "BUY"
                                        ? (leg.currentLtp <= leg.slTriggerPrice * 1.02)
                                        : (leg.currentLtp >= leg.slTriggerPrice * 0.98);

                                    if (isNearTrigger) {
                                        try {
                                            const api = await getAuthorizedInstance(config.connectionId);
                                            const details = await api.indOrderDetails(leg.slUniqueOrderId);
                                            if (details?.status && details?.data) {
                                                const orderStatus = (details.data.orderstatus || details.data.status || "").toString().toLowerCase();
                                                if (orderStatus === "complete" || orderStatus === "filled") {
                                                    console.log(`[${new Date().toISOString()}] Exchange SL hit for leg ${leg.instrument.symbol}.`);
                                                    leg.exchangeSlProcessed = true;
                                                    await handleLegStopOut(leg, "EXCHANGE_STOP_LOSS", strategy);
                                                }
                                            }
                                        } catch (err) {
                                            console.error("Error checking exchange SL status:", err.message);
                                        }
                                    }
                                }
                            }
                        }


                        // Check Exit Time
                        if (currentTime >= config.exit_time) {
                            if (strategy.exitAttempted) return;
                            strategy.exitAttempted = true;
                            console.log(`[${new Date().toISOString()}] Exit time reached for ${strategyId}`);
                            addStrategyLog(strategyId, `Exit Time ${config.exit_time} reached. Squaring off all legs.`, "INFO");

                            // 1. Cancel any pending orders (Entry or SL) first for active legs
                            if (!config.is_paper_trading) {
                                await Promise.all(strategy.legs.map(async (leg) => {
                                    if (leg.exited) return;

                                    try {
                                        const api = await getAuthorizedInstance(config.connectionId);

                                        // A. Cancel Exit Stop Loss if it exists
                                        if (leg.slOrderId) {
                                            await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                                            console.log(`Cancelled pending SL order ${leg.slOrderId} for ${leg.instrument.symbol} at exit time`);
                                        }

                                        // B. Cancel Entry Order if it's still waiting (entryPrice is null)
                                        if (!leg.entryPrice && leg.orderId) {
                                            // Entry variety could be STOPLOSS (re-cost) or config.variety (usually NORMAL)
                                            try {
                                                await api.cancelOrder({ variety: "NORMAL", orderid: leg.orderId });
                                            } catch (e) {
                                                await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.orderId });
                                            }
                                            console.log(`Cancelled pending entry order ${leg.orderId} for ${leg.instrument.symbol} at exit time`);
                                        }
                                    } catch (e) {
                                        console.error(`Cleanup failed for leg ${leg.instrument?.symbol}:`, e.message);
                                    }
                                }));
                            }

                            // 2. Place Exit Orders for remaining active legs (respects LIMIT/MARKET config)
                            // Note: placeExitOrder now handles entryPrice=null safety internally as well.
                            const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
                                if (leg.exited) return leg.exitOrderId;
                                return await placeExitOrder({
                                    config,
                                    leg,
                                    instrument: leg.instrument,
                                    exitType: "EXIT_TIME"
                                });
                            }));

                            strategy.status = "COMPLETED";
                            strategy.exitOrderId = exitOrders;
                            strategy.exitType = "EXIT_TIME";
                            updateStrategyInMemory(strategyId, {
                                status: "COMPLETED",
                                exit_order_id: strategy.exitOrderId,
                                exit_type: "EXIT_TIME",
                                final_pnl_percent: strategy.pnlPercent,
                                totalPnlRupees: strategy.totalPnlRupees,
                                totalOriginalValue: strategy.totalOriginalValue,
                                legs: strategy.legs
                            });
                            clearInterval(interval);
                        }
                    }

                    // Automatic Completion Check: If all legs have exited, finalize strategy
                    const allExited = strategy.legs.every(l => l.exited);
                    if (allExited) {
                        console.log(`[${new Date().toISOString()}] All legs exited for strategy ${strategyId}. Completing strategy.`);
                        strategy.status = "COMPLETED";
                        strategy.exitOrderId = strategy.legs.map(l => l.slOrderId || l.exitOrderId);
                        strategy.exitType = "LEGS_COMPLETED";
                        updateStrategyInMemory(strategyId, {
                            status: "COMPLETED",
                            exit_order_id: strategy.exitOrderId,
                            exit_type: "LEGS_COMPLETED",
                            final_pnl_percent: strategy.pnlPercent,
                            totalPnlRupees: strategy.totalPnlRupees,
                            totalOriginalValue: strategy.totalOriginalValue,
                            legs: strategy.legs
                        });
                        clearInterval(interval);
                        return;
                    }
                    // Periodic persistence to DB (every 30 seconds)
                    if (strategy.status === "IN_POSITION" && strategy.persistenceTicks >= 30) {
                        strategy.persistenceTicks = 0;
                        updateStrategyInMemory(strategyId, {
                            currentActivePnlPercent: strategy.pnlPercent,
                            totalPnlRupees: strategy.totalPnlRupees,
                            legs: strategy.legs
                        });
                    }
                } catch (err) {
                    console.error(`[${strategyId}] Monitoring/Exit failed:`, err.message);
                }
            }
        } catch (intervalErr) {
            console.error("Strategy Interval Error", intervalErr);
        } finally {
            strategy.isProcessing = false;
        }
    }, 1000); // Check every 1 second for precise timing

    strategy.interval = interval;
}

async function saveStrategy(config) {
    const data = await prisma.strategies.create({
        data: {
            name: config.name || `Strategy ${new Date().toLocaleTimeString()}`,
            config: config
        }
    });
    return data;
}

async function updateStrategy(strategyId, config) {
    const data = await prisma.strategies.update({
        where: { id: strategyId },
        data: {
            name: config.name || `Strategy ${new Date().toLocaleTimeString()}`,
            config: config
        }
    });

    return data;
}

async function deleteStrategy(strategyId) {
    await prisma.strategies.delete({
        where: { id: strategyId }
    });
    return true;
}

async function startStrategy(strategyId) {
    // strategyId is the template ID.
    const template = await prisma.strategies.findUnique({
        where: { id: strategyId }
    });

    if (!template) throw new Error("Strategy template not found in DB");

    // Insert a new execution
    const execution = await prisma.strategy_executions.create({
        data: {
            strategy_id: template.id,
            status: 'WAITING',
            execution_details: {}
        }
    });

    if (!execution) throw new Error("Failed to create execution record");

    const runtimeStrategy = {
        id: execution.id,  // Active Map maps execution_id to runtime state
        config: template.config,
        status: "WAITING",
        entryAttempted: false,
        startTime: new Date()
    };

    activeStrategies.set(execution.id, runtimeStrategy);
    executeStrategy(execution.id);

    return execution.id;
}

async function squareOffStrategy(strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy is not active or not found");
    if (strategy.status !== "IN_POSITION") throw new Error('Strategy must be in IN_POSITION to be squared off');

    const { config } = strategy;
    if (strategy.exitAttempted) throw new Error('Exit already in progress');
    strategy.exitAttempted = true;
    addStrategyLog(strategyId, "MANUAL SQUARE OFF triggered. Closing all positions...", "CRITICAL");
    console.log(`[${new Date().toISOString()}] Manual Square Off triggered for ${strategyId}`);

    // 1. Cancel any pending SL orders on exchange
    if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
        await Promise.all(strategy.legs.map(async (leg) => {
            if (!leg.exited && leg.slOrderId) {
                try {
                    const api = await getAuthorizedInstance(config.connectionId);
                    await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                    console.log(`Cancelled SL order ${leg.slOrderId} for ${leg.instrument?.symbol || 'Unknown'} due to manual square off`);
                } catch (e) {
                    console.error(`Failed to cancel SL order ${leg.slOrderId}:`, e.message);
                }
            }
        }));
    }

    // 2. Place Exit Orders (respects LIMIT/MARKET config just like Exit Time)
    const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
        if (leg.exited) return leg.exitOrderId;

        return await placeExitOrder({
            config: config,
            leg,
            instrument: leg.instrument,
            exitType: "MANUAL_SQUARE_OFF"
        });
    }));

    strategy.status = "COMPLETED";
    strategy.exitOrderId = exitOrders;
    strategy.exitType = "MANUAL_SQUARE_OFF";

    updateStrategyInMemory(strategyId, {
        status: "COMPLETED",
        exit_order_id: strategy.exitOrderId,
        exit_type: "MANUAL_SQUARE_OFF",
        final_pnl_percent: strategy.pnlPercent || 0,
        totalPnlRupees: strategy.totalPnlRupees || 0
    });

    if (strategy.interval) {
        clearInterval(strategy.interval);
    }

    return true;
}

async function squareOffLeg(strategyId, legIndex) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy is not active or not found");
    if (strategy.status !== "IN_POSITION") throw new Error('Strategy must be in IN_POSITION to square off a leg');

    const leg = strategy.legs[legIndex];
    if (!leg) throw new Error("Leg not found");
    if (leg.exited) throw new Error("Leg has already exited");
    if (leg.isExiting) throw new Error("Leg is already in process of exiting");

    const { config } = strategy;
    console.log(`[${new Date().toISOString()}] Manual Square Off triggered for leg index ${legIndex} of strategy ${strategyId}`);

    // Fast-path: If the leg is waiting for some condition (Recost, Mntm, ASAP, Lazy), it holds no position. Just cancel it.
    if (["WAITING_FOR_RECOST", "WAITING_FOR_MNTM", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY"].includes(leg.state)) {
        leg.state = "COMPLETED";
        leg.exited = true;
        leg.exitType = "MANUAL_CANCELLED_PENDING_ENTRY";
        leg.exitTime = getISTTime();
        return true;
    }

    // 1. Cancel pending SL order on exchange for this specific leg
    if (config.variety === "STOPLOSS" && !config.is_paper_trading && leg.slOrderId) {
        try {
            const api = await getAuthorizedInstance(config.connectionId);
            await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
            console.log(`Cancelled SL order ${leg.slOrderId} for leg ${leg.instrument.symbol} due to manual leg square off`);
        } catch (e) {
            console.error(`Failed to cancel SL order ${leg.slOrderId}:`, e.message);
        }
    }

    // 2. Place Exit Order for this leg
    await placeExitOrder({
        config: config,
        leg: leg,
        instrument: leg.instrument,
        exitType: "MANUAL_LEG_SQUARE_OFF"
    });

    // Strategy loop will handle pushing the leg to "COMPLETED" state when it checks that leg.exited is true
    return true;
}

async function stopStrategy(strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (strategy) {
        if (strategy.interval) {
            clearInterval(strategy.interval);
        }
        strategy.status = "TERMINATED";
        updateStrategyInMemory(strategyId, { status: "TERMINATED" });
        activeStrategies.delete(strategyId);
        return true;
    }
    return false;
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

    // Fallback to Prisma if execution not in active memory (e.g., cleared on restart)
    const dbExec = await prisma.strategy_executions.findUnique({
        where: { id: strategyId },
        include: { strategy: { select: { name: true } } }
    });

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
        totalPnlPercent: dbExec.total_pnl_percent || 0,
        exitType: dbExec.exit_type
    };
}

async function initializeActiveStrategies() {
    // console.log("Strategy Service: Initializing active strategies from DB...");
    try {
        const activeExecutions = await prisma.strategy_executions.findMany({
            where: {
                status: {
                    in: ["WAITING", "IN_POSITION"]
                }
            },
            include: {
                strategy: true
            }
        });

        // console.log(`Strategy Service: Found ${activeExecutions.length} active executions to restore`);

        for (const exec of activeExecutions) {
            if (!exec.strategy) continue;

            // Use the config from the template
            const runtimeStrategy = {
                id: exec.id,
                config: exec.strategy.config,
                status: exec.status,
                entryAttempted: exec.status === "IN_POSITION",
                startTime: exec.started_at,
                legs: (exec.execution_details && typeof exec.execution_details === 'object' && exec.execution_details.legs) ? exec.execution_details.legs : [],
                pnlPercent: Number(exec.final_pnl_percent || 0),
                totalPnlRupees: Number(exec.total_pnl_rupees || 0)
            };

            activeStrategies.set(exec.id, runtimeStrategy);
            executeStrategy(exec.id);
            // console.log(`Strategy Service: Restored strategy ${exec.id} (${exec.strategy.name}) in state ${exec.status}`);
        }
    } catch (err) {
        console.error("Strategy Service: Error initializing active strategies:", err.message);
    }
}

async function getUserStrategies() {
    const data = await prisma.strategies.findMany({
        orderBy: { created_at: 'desc' }
    });
    return data;
}

async function getActiveStrategies() {
    const executions = await prisma.strategy_executions.findMany({
        where: { status: { in: ['WAITING', 'IN_POSITION'] } },
        orderBy: { started_at: 'desc' },
        include: { strategy: { select: { name: true } } }
    });

    return Promise.all(executions.map(exec => getStatus(exec.id)));
}


async function getExecutionHistory() {
    const executions = await prisma.strategy_executions.findMany({
        where: {
            status: {
                in: ["COMPLETED", "FAILED", "TERMINATED", "CANCELLED", "STOPPED", "SQUARED_OFF"]
            }
        },
        orderBy: {
            completed_at: { sort: "desc", nulls: "last" }
        },
        include: {
            strategy: {
                select: {
                    name: true,
                    config: true
                }
            }
        },
        take: 50
    });

    return executions.map(dbExec => ({
        id: dbExec.id,
        status: dbExec.status,
        config: dbExec.execution_details?.config || dbExec.strategy?.config || {},
        name: dbExec.strategy?.name || (dbExec.execution_details?.config?.name) || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        logs: dbExec.execution_details?.logs || [],
        legs: dbExec.execution_details?.legs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalPnlRupees: dbExec.total_pnl_rupees || 0,
        totalOriginalValue: dbExec.execution_details?.totalOriginalValue || 0,
        exitType: dbExec.exit_type,
        started_at: dbExec.started_at,
        completed_at: dbExec.completed_at || dbExec.updatedAt
    }));
}

module.exports = {
    saveStrategy,
    updateStrategy,
    deleteStrategy,
    startStrategy,
    squareOffStrategy,
    squareOffLeg,
    stopStrategy,
    getStatus,
    updateLtp,
    getUserStrategies,
    getActiveStrategies,
    getExecutionHistory,
    initializeActiveStrategies
};
