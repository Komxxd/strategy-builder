const { getAuthorizedInstance } = require("../config/smartapi");
const marketService = require("./market.service");
const supabase = require("../config/supabase");
const fs = require("fs");
const path = require("path");

const INSTRUMENT_PATH = path.join(__dirname, "../data/instruments.json");
let instruments = [];
let activeStrategies = new Map();
// Local memory map 'savedStrategies' is removed in favor of Supabase

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
    // Fire and forget update to Supabase execution_details/status
    const updateData = {};
    if (data.status) updateData.status = data.status;
    if (data.final_pnl_percent !== undefined) updateData.final_pnl_percent = data.final_pnl_percent;
    if (data.totalPnlRupees !== undefined) updateData.total_pnl_rupees = data.totalPnlRupees;
    if (data.exit_type) updateData.exit_type = data.exit_type;

    updateData.execution_details = { ...(data.execution_details || {}), _latest: new Date().toISOString() };
    for (const key of Object.keys(data)) {
        if (['status', 'final_pnl_percent', 'totalPnlRupees', 'exit_type'].includes(key)) continue;
        updateData.execution_details[key] = data[key];
    }

    if (data.status === "COMPLETED" || data.status === "FAILED" || data.status === "TERMINATED") {
        updateData.completed_at = new Date().toISOString();
    }

    supabase.from('strategy_executions')
        .update(updateData)
        .eq('id', executionId)
        .then(({ error }) => {
            if (error) console.error(`Error updating execution ${executionId} in DB:`, error);
        });
}

function getATMStrike(indexName, spotPrice) {
    let step = 100;
    if (indexName === "NIFTY" || indexName === "FINNIFTY") step = 50;
    return Math.round(spotPrice / step) * step;
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

async function waitForOrderFillPrice(uniqueOrderId, connectionId, isPaperTrading = false, instrument = null, timeoutMs = 60000, pollMs = 2000) {
    if (isPaperTrading) {
        // For paper trading, try to get the current LTP as the fill price
        try {
            if (instrument) {
                const ltpRes = await marketService.getLTP({
                    exchange: instrument.exch_seg,
                    symboltoken: instrument.token
                });
                if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
                    return ltpRes.data.fetched[0].ltp;
                }
            }
        } catch (err) {
            console.error("Error getting paper fill price:", err);
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

async function placeExitOrder({ config, leg, instrument, exitType }) {
    if (leg.exited || leg.isExiting) return leg.exitOrderId;
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

function handleLegStopOut(leg, exitType, strategy) {
    // 1. Lock PnL and Mark CURRENT leg as completely exited
    leg.state = "COMPLETED";
    leg.exited = true;
    leg.exitType = exitType;
    leg.bookedPnlPoints = (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0);
    leg.bookedPnlRupees = (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0);
    leg.currentActivePnlPoints = 0;
    leg.currentActivePnlRupees = 0;

    // Wipe exchange fields to ensure clean exit visualization
    leg.slOrderId = null;
    leg.slUniqueOrderId = null;
    leg.slLimitPrice = null;
    leg.slTriggerPrice = null;
    leg.exchangeSlProcessed = true;

    if (leg.leg.recost_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        const otp = leg.original_traded_price;
        const mode = leg.leg.recost_mode || "RECOST_PLUS_PCT";
        const val = leg.leg.recost_value || 0;
        let rtp = otp;

        if (mode === "RECOST_PLUS_PCT") rtp = otp + (otp * val / 100);
        else if (mode === "RECOST_PLUS_PTS") rtp = otp + val;
        else if (mode === "RECOST_MINUS_PCT") rtp = otp - (otp * val / 100);
        else if (mode === "RECOST_MINUS_PTS") rtp = otp - val;

        const newRtp = roundToTick(rtp);

        // Spawn a brand new leg array element!
        const newLeg = {
            leg: { ...leg.leg }, // keep the configuration identical
            instrument: { ...leg.instrument },
            orderId: null,
            uniqueOrderId: null,
            exitOrderId: null,
            state: "WAITING_FOR_RECOST",
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: leg.currentLtp,
            last_tick_price: leg.currentLtp,

            reentry_count: leg.reentry_count, // Keeps context of how many times it was already re-entered

            original_traded_price: otp, // Carries over the original base entry price
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
            exchangeSlProcessed: false
        };

        strategy.legs.push(newLeg);

        console.log(`[RE-COST] New leg spawned for ${newLeg.instrument.symbol} in WAITING_FOR_RECOST. OTP: ${otp}, Calculated RTP: ${newRtp}`);
    } else {
        console.log(`[RE-COST] Leg ${leg.instrument.symbol} fully stopped out and completed. Re-entry disabled or count exhausted.`);
    }
}

async function executeStrategy(strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;

    const { config } = strategy;

    // Check loop
    const interval = setInterval(async () => {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

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
                            targetInstrument = findOptionInstrument(config.index, leg.option_type, targetStrike);
                            if (!targetInstrument) {
                                throw new Error(`Could not find ${leg.option_type} instrument for ${strikeLabel}`);
                            }
                        }
                        resolvedLegs.push({ leg, instrument: targetInstrument });
                    }
                    console.log(`Resolved ${resolvedLegs.length} legs. Placing orders...`);

                    const placedLegs = await Promise.all(resolvedLegs.map(async (item) => {
                        let finalPrice = (config.price || "0").toString();

                        if (config.ordertype === 'LIMIT') {
                            try {
                                const instLtpRes = await marketService.getLTP({
                                    exchange: item.instrument.exch_seg,
                                    symboltoken: item.instrument.token,
                                    connectionId: config.connectionId
                                });
                                if (instLtpRes.status && instLtpRes.data?.fetched?.[0]) {
                                    const instLtp = instLtpRes.data.fetched[0].ltp;
                                    const offset = parseFloat(config.entry_limit_offset || 0);
                                    if (item.leg.side === "BUY") {
                                        finalPrice = roundToTick(instLtp + offset).toString();
                                    } else {
                                        finalPrice = roundToTick(instLtp - offset).toString();
                                    }
                                    console.log(`[${new Date().toISOString()}] Limit Order Calc for ${item.instrument.symbol} (${item.leg.side}): LTP=${instLtp}, Offset=${offset}, FinalPrice=${finalPrice}`);
                                }
                            } catch (err) {
                                console.error(`Error calculating limit price for ${item.instrument.symbol}:`, err);
                            }
                        }

                        const orderData = await placeOrder(
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
                        return {
                            ...item,
                            orderId: orderData.orderid,
                            uniqueOrderId: orderData.uniqueorderid,
                            state: "ACTIVE",
                            original_traded_price: null,
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
                    }));

                    // Fetch entry fill prices and place stoploss exit orders if requested
                    // Fetch entry fill prices and place stoploss exit orders parallelly
                    await Promise.all(placedLegs.map(async (leg) => {
                        if (leg.uniqueOrderId) {
                            const fillPrice = await waitForOrderFillPrice(
                                leg.uniqueOrderId,
                                config.connectionId,
                                config.is_paper_trading === true,
                                leg.instrument
                            );
                            if (fillPrice) {
                                leg.entryPrice = fillPrice;
                                leg.original_traded_price = leg.original_traded_price || fillPrice;
                            } else {
                                const optLtpRes = await marketService.getLTP({
                                    exchange: leg.instrument.exch_seg,
                                    symboltoken: leg.instrument.token,
                                    connectionId: config.connectionId
                                });
                                if (optLtpRes.status && optLtpRes.data?.fetched?.[0]) {
                                    leg.entryPrice = optLtpRes.data.fetched[0].ltp;
                                    leg.original_traded_price = leg.original_traded_price || leg.entryPrice;
                                }
                            }
                        }

                        if (config.variety === "STOPLOSS" && leg.entryPrice) {
                            const slOrder = await placeStopLossExitOrder({
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
                    strategy.legs = placedLegs;

                    updateStrategyInMemory(strategyId, {
                        status: "IN_POSITION",
                        order_id: placedLegs.map(l => l.orderId),
                        entry_price: placedLegs.map(l => l.entryPrice),
                        instrument: placedLegs.map(l => l.instrument)
                    });

                    console.log(`Strategy ${strategyId} in position: ${placedLegs.map(l => l.instrument.symbol).join(", ")}`);
                }
            } catch (err) {
                console.error("Execution failed", err);
                strategy.status = "FAILED";
                strategy.error = err.message;
                updateStrategyInMemory(strategyId, { status: "FAILED", error: err.message });
                clearInterval(interval);
            }
        }

        // Monitoring for Stop Loss or Exit Time
        if (strategy.status === "IN_POSITION" && strategy.legs?.length) {
            try {
                await Promise.all(strategy.legs.map(async (leg) => {
                    if (leg.exited && leg.state !== "WAITING_FOR_RECOST") return; // Skip closed legs for LTP updates

                    const currentLtpRes = await marketService.getLTP({
                        exchange: leg.instrument.exch_seg,
                        symboltoken: leg.instrument.token,
                        connectionId: config.connectionId
                    });
                    if (currentLtpRes.status && currentLtpRes.data?.fetched?.[0]) {
                        leg.currentLtp = currentLtpRes.data.fetched[0].ltp;

                        // RE-COST Engines: Crossing Logic
                        if (leg.state === "WAITING_FOR_RECOST" && leg.last_tick_price !== null) {
                            const currentTick = leg.currentLtp;
                            const prevTick = leg.last_tick_price;
                            const rtp = leg.recost_trigger_price;

                            let triggerReEntry = false;

                            if (leg.leg.side === "BUY") {
                                if (leg.leg.recost_mode.includes("PLUS")) {
                                    // BUY RECOST+ (Enter higher): Price drops below RTP then crosses upward
                                    if (prevTick <= rtp && currentTick > rtp) triggerReEntry = true;
                                } else {
                                    // BUY RECOST- (Enter lower): Price rises above RTP then crosses downward
                                    if (prevTick >= rtp && currentTick < rtp) triggerReEntry = true;
                                }
                            } else {
                                if (leg.leg.recost_mode.includes("PLUS")) {
                                    // SELL RECOST+ (Enter higher): Price rises above RTP then crosses downward
                                    if (prevTick >= rtp && currentTick < rtp) triggerReEntry = true;
                                } else {
                                    // SELL RECOST- (Enter lower): Price drops below RTP then crosses upward
                                    if (prevTick <= rtp && currentTick > rtp) triggerReEntry = true;
                                }
                            }

                            if (triggerReEntry) {
                                console.log(`[RE-COST] Condition met for ${leg.instrument.symbol}! Re-entering (Attempt ${leg.reentry_count + 1}/${leg.leg.max_reentry})...`);
                                leg.reentry_count++;
                                leg.entryPrice = null; // IMPORTANT: Clear this out so Stop Loss engine aborts checking while we wait for fill!
                                leg.state = "ACTIVE";

                                let finalPrice = (config.price || "0").toString();
                                if (config.ordertype === 'LIMIT') {
                                    const offset = parseFloat(config.entry_limit_offset || 0);
                                    if (leg.leg.side === "BUY") {
                                        finalPrice = roundToTick(currentTick + offset).toString();
                                    } else {
                                        finalPrice = roundToTick(currentTick - offset).toString();
                                    }
                                }

                                try {
                                    const reEntryOrder = await placeOrder(
                                        {
                                            ...config,
                                            side: leg.leg.side,
                                            variety: config.variety === "STOPLOSS" ? "NORMAL" : config.variety, // Force Normal for re-entries generally to guarantee market fill, sl tracking applies next
                                            ordertype: config.ordertype,
                                            price: finalPrice,
                                            lots: leg.leg.lots
                                        },
                                        leg.instrument,
                                        config.connectionId
                                    );

                                    leg.orderId = reEntryOrder.orderid;
                                    leg.uniqueOrderId = reEntryOrder.uniqueorderid;

                                    // Wait for fill cleanly
                                    setTimeout(async () => {
                                        try {
                                            const fill = await waitForOrderFillPrice(leg.uniqueOrderId, config.connectionId, config.is_paper_trading === true, leg.instrument);
                                            leg.entryPrice = fill || currentTick;
                                        } catch (e) { leg.entryPrice = currentTick; }

                                        // Redeploy exchange SL if needed
                                        if (config.variety === "STOPLOSS") {
                                            const activeSlType = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                                            const activeSlValue = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : leg.leg.stop_loss;

                                            const slOrder = await placeStopLossExitOrder({
                                                baseConfig: config,
                                                legSide: leg.leg.side,
                                                entryPrice: leg.entryPrice,
                                                instrument: leg.instrument,
                                                lots: leg.leg.lots,
                                                slType: activeSlType,
                                                slValue: activeSlValue,
                                                slLimitMargin: config.entry_limit_offset,
                                                connectionId: config.connectionId
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
                                    }, 500);
                                } catch (err) {
                                    console.error("[RE-COST] Re-entry failed. Halting leg completely.", err);
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
                }));

                // Strategy PnL is the sum of all legs (active + exited)
                const validPnls = strategy.legs
                    .map(l => (typeof l.pnlPercent === "number" ? l.pnlPercent : null))
                    .filter(v => v !== null);
                const avgPnl = validPnls.length ? validPnls.reduce((a, b) => a + b, 0) / validPnls.length : 0;
                strategy.pnlPercent = avgPnl;

                const totalPnlRupees = strategy.legs.reduce((sum, l) => sum + (l.pnlRupees || 0), 0);
                strategy.totalPnlRupees = totalPnlRupees;

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
                                    console.log(`Cancelled SL order ${leg.slOrderId} for ${leg.instrument.symbol} due to overall SL`);
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
                            handleLegStopOut(leg, "LEG_STOP_LOSS", strategy);
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
                                            handleLegStopOut(leg, "EXCHANGE_STOP_LOSS", strategy);
                                        }
                                    }
                                } catch (err) {
                                    console.error("Error checking exchange SL status:", err.message);
                                }
                            }
                        }
                    }
                }

                // Check if all legs have exited
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

                // Check Exit Time
                if (currentTime >= config.exit_time) {
                    if (strategy.exitAttempted) return;
                    strategy.exitAttempted = true;
                    console.log(`[${new Date().toISOString()}] Exit time reached for ${strategyId}`);

                    // 1. Cancel any pending SL orders first for active legs
                    if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
                        await Promise.all(strategy.legs.map(async (leg) => {
                            if (!leg.exited && leg.slOrderId) {
                                try {
                                    const api = await getAuthorizedInstance(config.connectionId);
                                    await api.cancelOrder({
                                        variety: "STOPLOSS",
                                        orderid: leg.slOrderId
                                    });
                                    console.log(`Cancelled pending SL order ${leg.slOrderId} for ${leg.instrument.symbol} at exit time`);
                                } catch (e) {
                                    console.error(`Failed to cancel SL order ${leg.slOrderId}:`, e.message);
                                }
                            }
                        }));
                    }

                    // 2. Place Exit Orders for remaining active legs (respects LIMIT/MARKET config)
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
            } catch (err) {
                console.error("Monitoring/Exit failed", err);
            }
        }
    }, 1000); // Check every 1 second for precise timing

    strategy.interval = interval;
}

async function saveStrategy(config) {
    const { data, error } = await supabase
        .from('strategies')
        .insert([{
            user_id: config.userId,
            name: config.name || `Strategy ${new Date().toLocaleTimeString()}`,
            config: config,
            status: "SAVED"
        }])
        .select()
        .single();

    if (error) throw new Error("Error saving strategy DB: " + error.message);
    return data;
}

async function updateStrategy(strategyId, config) {
    const { data, error } = await supabase
        .from('strategies')
        .update({
            name: config.name || `Strategy ${new Date().toLocaleTimeString()}`,
            config: config,
            updated_at: new Date().toISOString()
        })
        .eq('id', strategyId)
        .select()
        .single();

    if (error) throw new Error("Error updating strategy DB: " + error.message);
    return data;
}

async function deleteStrategy(strategyId) {
    const { error } = await supabase
        .from('strategies')
        .delete()
        .eq('id', strategyId);

    if (error) throw new Error("Error deleting strategy DB: " + error.message);
    return true;
}

async function startStrategy(strategyId) {
    // strategyId is the template ID.
    const { data: template, error } = await supabase
        .from('strategies')
        .select('*')
        .eq('id', strategyId)
        .single();

    if (error || !template) throw new Error("Strategy template not found in DB");

    // Insert a new execution
    const { data: execution, error: execError } = await supabase
        .from('strategy_executions')
        .insert([{
            strategy_id: template.id,
            user_id: template.user_id,
            status: 'WAITING'
        }])
        .select()
        .single();

    if (execError || !execution) throw new Error("Failed to create execution record: " + execError?.message);

    const runtimeStrategy = {
        id: execution.id,  // Active Map maps execution_id to runtime state
        user_id: template.user_id,
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
    console.log(`[${new Date().toISOString()}] Manual Square Off triggered for ${strategyId}`);

    // 1. Cancel any pending SL orders on exchange
    if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
        await Promise.all(strategy.legs.map(async (leg) => {
            if (!leg.exited && leg.slOrderId) {
                try {
                    const api = await getAuthorizedInstance(config.connectionId);
                    await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                    console.log(`Cancelled SL order ${leg.slOrderId} for ${leg.instrument.symbol} due to manual square off`);
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

    leg.isExiting = true;

    // Fast-path: If the leg is just waiting for Re-Cost, it holds no position. Just cancel the Recost.
    if (leg.state === "WAITING_FOR_RECOST") {
        leg.state = "COMPLETED";
        leg.exited = true;
        leg.exitType = "MANUAL_CANCELLED_RECOST";
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
            orderId: s.orderId,
            exitOrderId: s.exitOrderId,
            exitType: s.exitType,
            instrument: s.instrument,
            name: s.config?.name || "Deployed Strategy"
        };
    }

    // Fallback to Supabase if execution not in active memory (e.g., cleared on restart)
    const { data: dbExec, error } = await supabase
        .from('strategy_executions')
        .select(`
            *,
            strategy:strategies(name)
        `)
        .eq('id', strategyId)
        .single();

    if (error || !dbExec) return null;

    return {
        id: dbExec.id,
        status: dbExec.status,
        config: dbExec.execution_details?.config || {},
        name: dbExec.strategy?.name || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        legs: dbExec.execution_details?.legs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalPnlRupees: dbExec.total_pnl_rupees || 0,
        exitType: dbExec.exit_type
    };
}

async function getUserStrategies(userId) {
    const { data, error } = await supabase
        .from('strategies')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) throw new Error("Error fetching user strategies: " + error.message);
    return data;
}

async function getActiveStrategies(userId) {
    const { data: executions, error } = await supabase
        .from('strategy_executions')
        .select(`
            *,
            strategy:strategies(name)
        `)
        .eq('user_id', userId)
        .in('status', ['WAITING', 'IN_POSITION'])
        .order('started_at', { ascending: false });

    if (error) throw new Error("Error fetching active strategies: " + error.message);

    return Promise.all(executions.map(exec => getStatus(exec.id)));
}

async function getExecutionHistory(userId) {
    const { data: executions, error } = await supabase
        .from('strategy_executions')
        .select(`
            *,
            strategy:strategies(name, config)
        `)
        .eq('user_id', userId)
        .in('status', ['COMPLETED', 'FAILED', 'TERMINATED'])
        .order('completed_at', { ascending: false });

    if (error) throw new Error("Error fetching execution history: " + error.message);

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
    getUserStrategies,
    getActiveStrategies,
    getExecutionHistory
};
