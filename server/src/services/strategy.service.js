const { getAuthorizedInstance } = require("../config/smartapi");
const marketService = require("./market.service");
const marketSocketService = require("./marketSocket.service");
const prisma = require("../config/prisma");
const fs = require("fs");
const path = require("path");

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

async function runGlobalPriceFetcher() {
    if (isFetchingGlobalLtp) {
        if (!this.skipCount) this.skipCount = 0;
        this.skipCount++;
        if (this.skipCount % 5 === 0) {
            console.warn(`[PriceFetcher] WARNING: Skip count is ${this.skipCount}. Previous fetch is taking too long! Overlapping executions prevented.`);
        }
        return;
    }
    this.skipCount = 0;
    // if (activeStrategies.size === 0) return; // This return is moved later

    // --- STEP 0: Build Task Map ---
    const tasks = {}; // { connectionId: { exchange: Set(tokens) } }
    const unifiedTasks = {}; // { exchange: Set(tokens) }

    for (const [id, strategy] of activeStrategies) {
        if (strategy.status !== "IN_POSITION" || !strategy.legs) continue;
        const connId = strategy.config.connectionId;
        if (!tasks[connId]) tasks[connId] = {};

        for (const leg of strategy.legs) {
            if ((leg.exited && leg.state !== "WAITING_FOR_RECOST") || !leg.instrument) continue;
            const exch = leg.instrument.exch_seg;
            const token = leg.instrument.token;

            if (!tasks[connId][exch]) tasks[connId][exch] = new Set();
            tasks[connId][exch].add(token);

            if (!unifiedTasks[exch]) unifiedTasks[exch] = new Set();
            unifiedTasks[exch].add(token);
        }
    }

    // --- STEP 1: WebSocket Sync (even if 0 active) ---
    // If no active strategies, unifiedTasks will be empty {}
    // syncSubscriptions will correctly unsubscribe from everything.
    marketSocketService.syncSubscriptions(unifiedTasks);

    if (activeStrategies.size === 0 || Object.keys(tasks).length === 0) return;

    if (isFetchingGlobalLtp) return;

    isFetchingGlobalLtp = true;
    const startTime = Date.now();
    let totalTokens = 0;
    let totalChunks = 0;
    let successfulChunks = 0;
    let failedChunks = 0;

    try {
        const chunkTasks = [];

        for (const [connId, exchanges] of Object.entries(tasks)) {
            // Handle stringified 'undefined' from Object.entries keys
            const effectiveConnId = connId === "undefined" ? undefined : connId;

            for (const [exch, tokensSet] of Object.entries(exchanges)) {
                const allTokens = Array.from(tokensSet);
                totalTokens += allTokens.length;

                for (let i = 0; i < allTokens.length; i += 40) {
                    const chunk = allTokens.slice(i, i + 40);
                    totalChunks++;

                    // Create a promise for each chunk to execute in parallel
                    chunkTasks.push((async () => {
                        try {
                            const ltpRes = await marketService.getLTP({
                                exchange: exch,
                                symboltoken: chunk,
                                connectionId: effectiveConnId
                            });

                            if (ltpRes?.status && ltpRes?.data?.fetched) {
                                successfulChunks++;
                                for (const item of ltpRes.data.fetched) {
                                    const t = item.symbolToken || item.symboltoken;
                                    if (t && item.ltp) {
                                        globalLtpMap[`${exch}_${t}`] = item.ltp;
                                    }
                                }
                            } else {
                                failedChunks++;
                                const msg = ltpRes?.message || "Unknown error status";
                                console.error(`[PriceFetcher] SmartAPI Error for ${exch} (Conn: ${effectiveConnId}). Resp: ${JSON.stringify(ltpRes)}`);
                                if (msg && typeof msg === 'string' && msg.toLowerCase().includes("rate limit")) {
                                    console.error("[PriceFetcher] CRITICAL: Rate limited by AngelOne!");
                                }
                            }
                        } catch (err) {
                            failedChunks++;
                            console.error(`[PriceFetcher] Exception fetching LTP for ${exch} (Conn: ${effectiveConnId}):`, err.message);
                        }
                    })());
                }
            }
        }

        // Parallelize all chunk requests
        if (chunkTasks.length > 0) {
            await Promise.all(chunkTasks);
        }
    } catch (globalErr) {
        console.error("[PriceFetcher] Fatal crash in global price fetcher:", globalErr);
    } finally {
        const duration = Date.now() - startTime;
        if (duration > 1000 || failedChunks > 0 || totalChunks > 2) {
            console.log(`[PriceFetcher] Done: ${totalTokens} tokens, ${totalChunks} chunks. Success: ${successfulChunks}, Failed: ${failedChunks}. Duration: ${duration}ms`);
        }
        isFetchingGlobalLtp = false;
    }
}

// Start price fetcher heartbeat once globally
setInterval(runGlobalPriceFetcher, 1000);

function loadInstruments() {
    if (instruments.length > 0) return;
    try {
        if (fs.existsSync(INSTRUMENT_PATH)) {
            const raw = fs.readFileSync(INSTRUMENT_PATH, "utf-8");
            instruments = JSON.parse(raw);
            console.log("Strategy Service: Instruments loaded", instruments.length);
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
        updateData.execution_details[key] = data[key];
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

    console.log(`[Log][${strategyId}] ${message}`);
}

function findOptionInstrument(indexName, optionType, strike) {
    loadInstruments();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const matches = instruments.filter(inst =>
        inst.name === indexName &&
        inst.instrumenttype === "OPTIDX" &&
        inst.symbol.endsWith(optionType) &&
        (parseFloat(inst.strike) / 100) === strike &&
        new Date(inst.expiry) >= today
    );

    if (matches.length === 0) return null;

    // Sort by expiry to get the nearest one
    matches.sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

    return matches[0];
}

async function findClosestPremiumInstrument(indexName, optionType, targetPremium, connectionId) {
    loadInstruments();
    const exchange = indexName === "SENSEX" ? "BFO" : "NFO";

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1. Get all options for this index and type
    const matches = instruments.filter(inst =>
        inst.name === indexName &&
        inst.instrumenttype === "OPTIDX" &&
        inst.symbol.endsWith(optionType) &&
        new Date(inst.expiry) >= today
    );

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
        if (!paperConfig || paperConfig.ordertype === "MARKET") {
            try {
                if (instrument) {
                    const ltpRes = await marketService.getLTP({
                        exchange: instrument.exch_seg,
                        symboltoken: instrument.token,
                        connectionId: connectionId
                    });
                    if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
                        const ltp = ltpRes.data.fetched[0].ltp;
                        console.log(`[PAPER_FILL] Instant Market Fill for ${instrument.symbol} at ${ltp}`);
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
    if (leg.exited || leg.isExiting) return leg.exitOrderId;

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
                // Variety for entry is usually NORMAL (see executeStrategy)
                await api.cancelOrder({ variety: "NORMAL", orderid: leg.orderId });
                console.log(`[Exit] Successfully cancelled pending entry order ${leg.orderId}`);
                leg.exited = true;
                leg.isExiting = false;
                leg.exitType = exitType || "CANCELLED_NO_ENTRY";
                leg.exitTime = getISTTime();
                return null;
            } catch (e) {
                console.warn(`[Exit] Cancellation failed for ${leg.orderId}: ${e.message}. It may have filled. Proceeding with MARKET exit.`);
                // If it fails to cancel, it might have filled. Fall through to place a market exit order.
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

    const exitSide = leg.leg.side === "BUY" ? "SELL" : "BUY";
    let exitOrderType = config.ordertype === "LIMIT" ? "LIMIT" : "MARKET";
    let finalPrice = "0";

    if (exitOrderType === "LIMIT") {
        try {
            const ltpRes = await marketService.getLTP({
                exchange: instrument.exch_seg,
                symboltoken: instrument.token,
                connectionId: config.connectionId
            });
            if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
                const ltp = ltpRes.data.fetched[0].ltp;
                const offset = parseFloat(config.entry_limit_offset || 0);

                // For exit SELL (closing BUY): price = LTP - offset (to be aggressive and fill)
                // For exit BUY (closing SELL): price = LTP + offset (to be aggressive and fill)
                if (exitSide === "SELL") {
                    finalPrice = roundToTick(ltp - offset).toString();
                } else {
                    finalPrice = roundToTick(ltp + offset).toString();
                }
            } else if (leg.currentLtp) {
                console.warn(`Could not fetch fresh LTP for exit of ${instrument.symbol}, falling back to last known active LTP: ${leg.currentLtp}`);
                const ltp = leg.currentLtp;
                const offset = parseFloat(config.entry_limit_offset || 0);

                if (exitSide === "SELL") {
                    finalPrice = roundToTick(ltp - offset).toString();
                } else {
                    finalPrice = roundToTick(ltp + offset).toString();
                }
            } else {
                console.warn(`Could not fetch LTP for exit of ${instrument.symbol} and no previous LTP available, falling back to MARKET. API Response:`, JSON.stringify(ltpRes));
                exitOrderType = "MARKET";
            }
        } catch (err) {
            if (leg.currentLtp) {
                console.warn(`Error calculating limit exit price for ${instrument.symbol}, falling back to last known active LTP:`, err.message);
                const ltp = leg.currentLtp;
                const offset = parseFloat(config.entry_limit_offset || 0);
                if (exitSide === "SELL") finalPrice = roundToTick(ltp - offset).toString();
                else finalPrice = roundToTick(ltp + offset).toString();
            } else {
                console.error(`Error calculating limit exit price for ${instrument.symbol}:`, err.message);
                exitOrderType = "MARKET";
            }
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
    leg.exited = true;
    leg.exitOrderId = orderData.orderid;
    leg.exitType = exitType;
    leg.exitTime = getISTTime();
    return orderData.orderid;
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
                        strategyId: strategyId
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
    } else {
        console.log(`[RE-COST] Leg ${leg.instrument.symbol} fully stopped out and completed. Re-entry disabled or count exhausted.`);
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
                console.log(`Entry time reached for ${strategyId}`);
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

                    console.log(`Fetching LTP for ${config.index} (${indexExchange}:${indexToken})...`);
                    const ltpRes = await marketService.getLTP({
                        exchange: indexExchange,
                        symboltoken: indexToken,
                        connectionId: config.connectionId // PASS AUTH ALONG
                    });

                    if (ltpRes.status && ltpRes.data && ltpRes.data.fetched && ltpRes.data.fetched.length > 0) {
                        const spotPrice = ltpRes.data.fetched[0].ltp;
                        console.log(`Spot Price for ${config.index}: ${spotPrice}`);
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
                                console.log(`Execution Search: Index=${config.index}, Spot=${spotPrice}, ATM=${atmStrike}, Selected=${strikeLabel}, TargetStrike=${targetStrike}, Type=${leg.option_type}`);
                                addStrategyLog(strategyId, `Leg ${resolvedLegs.length + 1}: Selecting ${strikeLabel} (${leg.option_type}) at Strike ${targetStrike}.`, "INFO");
                                targetInstrument = findOptionInstrument(config.index, leg.option_type, targetStrike);
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
                                    leg.instrument
                                );
                                if (fillPrice) {
                                    leg.entryPrice = fillPrice;
                                    leg.entryTime = getISTTime();
                                    leg.original_traded_price = fillPrice;
                                    leg.base_otp = fillPrice;
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
                                if (slOrder?.orderid) {
                                    const prices = computeStopLossExitPrices(
                                        leg.entryPrice,
                                        leg.leg.side,
                                        leg.leg.sl_type || "PERCENTAGE",
                                        leg.leg.stop_loss,
                                        config.entry_limit_offset
                                    );
                                    leg.slOrderId = slOrder.orderid;
                                    leg.slUniqueOrderId = slOrder.uniqueorderid;
                                    leg.slTriggerPrice = prices?.trigger || null;
                                    leg.slLimitPrice = prices?.limit || null;
                                }
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

                        console.log(`Strategy ${strategyId} in position: ${strategy.legs.map(l => l.instrument.symbol).join(", ")}`);
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
                    const activeLegs = strategy.legs.filter(leg => !(leg.exited && !["WAITING_FOR_RECOST", "WAITING_FOR_RE_ASAP"].includes(leg.state)));

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
                                        targetInstrument = findOptionInstrument(config.index, leg.leg.option_type, targetStrike);
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
                                            if (slOrder?.orderid) {
                                                const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss, config.entry_limit_offset);
                                                leg.slOrderId = slOrder.orderid;
                                                leg.slUniqueOrderId = slOrder.uniqueorderid;
                                                leg.slTriggerPrice = prices?.trigger || null;
                                                leg.slLimitPrice = prices?.limit || null;
                                            }
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
                                                        28800000, // 8 Hours Timeout MS
                                                        1000,     // 1 Sec Poll Interval
                                                        {         // Inject Advanced Paper Config
                                                            side: side,
                                                            ordertype: ordertype,
                                                            price: parseFloat(finalPriceStr || 0),
                                                            triggerprice: parseFloat(triggerPriceStr || 0)
                                                        }
                                                    );
                                                    leg.entryPrice = fill || currentTick;
                                                    leg.entryTime = getISTTime();
                                                    leg.original_traded_price = leg.entryPrice;
                                                    // base_otp is inherited and stays constant across re-entries
                                                } catch (e) {
                                                    leg.entryPrice = currentTick;
                                                    leg.entryTime = getISTTime();
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
                                                    if (slOrder?.orderid) {
                                                        const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, activeSlType, activeSlValue, config.entry_limit_offset);
                                                        leg.slOrderId = slOrder.orderid;
                                                        leg.slUniqueOrderId = slOrder.uniqueorderid;
                                                        leg.slTriggerPrice = prices?.trigger;
                                                        leg.slLimitPrice = prices?.limit;
                                                        leg.exchangeSlProcessed = false;
                                                    }
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
                                totalPnlRupees: totalPnlRupees
                            });
                            clearInterval(interval);
                            return;
                        }

                        // Check Leg-wise Stop Loss (%) only if we didn't place SmartAPI SL orders (or if it's paper trading)
                        if (config.variety !== "STOPLOSS" || config.is_paper_trading === true) {
                            for (const leg of strategy.legs) {
                                if (leg.exited || leg.state === "WAITING_FOR_RECOST") continue;

                                const isReentered = leg.reentry_count > 0;
                                const activeSlType = isReentered && leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                                const activeSlValue = isReentered && leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : (leg.leg.stop_loss || 0);

                                let isHit = false;
                                if (activeSlType === "POINTS") {
                                    isHit = leg.currentActivePnlPoints <= -activeSlValue;
                                } else {
                                    isHit = leg.currentActivePnlPercent <= -activeSlValue;
                                }

                                if (isHit) {
                                    console.log(`[${new Date().toISOString()}] Manual Stop Loss hit for leg ${leg.instrument.symbol}: PnL=${leg.pnlPercent.toFixed(2)}%`);
                                    await placeExitOrder({
                                        config,
                                        leg,
                                        instrument: leg.instrument,
                                        exitType: "LEG_STOP_LOSS"
                                    });
                                    await handleLegStopOut(leg, "LEG_STOP_LOSS", strategy);
                                }
                            }
                        } else {
                            // Real Stop Loss handling for variety="STOPLOSS"
                            // Check if any exchange SL was hit
                            for (const leg of strategy.legs) {
                                if (leg.exited || leg.state === "WAITING_FOR_RECOST") continue;
                                if (leg.slUniqueOrderId && !leg.exchangeSlProcessed) {
                                    // Only check exchange if price is close to trigger (to save API quota)
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
                                totalPnlRupees: strategy.totalPnlRupees
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
                            totalPnlRupees: strategy.totalPnlRupees
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

    // Fast-path: If the leg is just waiting for Re-Cost, it holds no position. Just cancel the Recost.
    if (leg.state === "WAITING_FOR_RECOST") {
        leg.state = "COMPLETED";
        leg.exited = true;
        leg.exitType = "MANUAL_CANCELLED_RECOST";
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
    console.log("Strategy Service: Initializing active strategies from DB...");
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

        console.log(`Strategy Service: Found ${activeExecutions.length} active executions to restore`);

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
            console.log(`Strategy Service: Restored strategy ${exec.id} (${exec.strategy.name}) in state ${exec.status}`);
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
        where: { status: { in: ['COMPLETED', 'FAILED', 'TERMINATED'] } },
        orderBy: { completed_at: 'desc' },
        include: { strategy: { select: { name: true, config: true } } }
    });

    return executions.map(dbExec => ({
        id: dbExec.id,
        status: dbExec.status,
        config: dbExec.execution_details?.config || dbExec.strategy?.config || {},
        name: dbExec.strategy?.name || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        legs: dbExec.execution_details?.legs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalPnlRupees: dbExec.total_pnl_rupees || 0,
        exitType: dbExec.exit_type,
        started_at: dbExec.started_at,
        completed_at: dbExec.completed_at
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
