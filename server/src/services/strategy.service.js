const { getAuthorizedInstance } = require("../config/smartapi");
const marketService = require("./market.service");
const optionChainService = require("./optionChain.service");
const fs = require("fs");
const path = require("path");

const INSTRUMENT_PATH = path.join(__dirname, "../data/instruments.json");
let instruments = [];
let activeStrategies = new Map();
let savedStrategies = new Map();

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

function updateStrategyInMemory(strategyId, data) {
    const existing = savedStrategies.get(strategyId);
    if (!existing) return;
    savedStrategies.set(strategyId, { ...existing, ...data });
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

async function findClosestPremiumInstrument(indexName, optionType, targetPremium) {
    const exchange = indexName === "SENSEX" ? "BSE" : "NSE";
    const chainData = optionChainService.getOptionChain({ symbol: indexName, exchange: exchange });
    if (!chainData || !chainData.chain) return null;

    const tokens = chainData.chain.map(c => c[optionType]?.token).filter(Boolean);
    if (tokens.length === 0) return null;

    // Batch get LTP for all tokens in the chain
    // Angel supports many tokens in batch, but let's be safe if chain is huge
    const ltpRes = await marketService.getLTP({
        exchange,
        symboltoken: tokens
    });

    if (!ltpRes.status || !ltpRes.data?.fetched) return null;

    let closest = null;
    let minDiff = Infinity;

    for (const fetched of ltpRes.data.fetched) {
        const diff = Math.abs(fetched.ltp - targetPremium);
        if (diff < minDiff) {
            minDiff = diff;
            closest = fetched;
        }
    }

    if (!closest) return null;

    // Find the instrument details from our chainData
    for (const item of chainData.chain) {
        if (item[optionType]?.token === closest.symboltoken) {
            return item[optionType];
        }
    }

    return null;
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
            }
        } catch (err) {
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
                    symboltoken: indexToken
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
                            targetInstrument = await findClosestPremiumInstrument(config.index, leg.option_type, leg.premium);
                            if (!targetInstrument) {
                                throw new Error(`Could not find ${leg.option_type} instrument with premium close to ₹${leg.premium}`);
                            }
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
                                    symboltoken: item.instrument.token
                                });
                                if (instLtpRes.status && instLtpRes.data?.fetched?.[0]) {
                                    const instLtp = instLtpRes.data.fetched[0].ltp;
                                    const offset = parseFloat(config.entry_limit_offset || 0);
                                    finalPrice = roundToTick(instLtp + offset).toString();
                                    console.log(`[${new Date().toISOString()}] Limit Order Calc for ${item.instrument.symbol}: LTP=${instLtp}, Offset=${offset}, FinalPrice=${finalPrice}`);
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
                            entryPrice: null,
                            currentLtp: null,
                            pnlPercent: 0,
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
                                null,
                                config.is_paper_trading === true,
                                leg.instrument
                            );
                            if (fillPrice) {
                                leg.entryPrice = fillPrice;
                            } else {
                                const optLtpRes = await marketService.getLTP({
                                    exchange: leg.instrument.exch_seg,
                                    symboltoken: leg.instrument.token
                                });
                                if (optLtpRes.status && optLtpRes.data?.fetched?.[0]) {
                                    leg.entryPrice = optLtpRes.data.fetched[0].ltp;
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
                    if (leg.exited) return; // Skip closed legs for LTP updates

                    const currentLtpRes = await marketService.getLTP({
                        exchange: leg.instrument.exch_seg,
                        symboltoken: leg.instrument.token
                    });
                    if (currentLtpRes.status && currentLtpRes.data?.fetched?.[0]) {
                        leg.currentLtp = currentLtpRes.data.fetched[0].ltp;
                        if (leg.entryPrice) {
                            const pnlPoints = leg.leg.side === "BUY"
                                ? (leg.currentLtp - leg.entryPrice)
                                : (leg.entryPrice - leg.currentLtp);
                            leg.pnlPercent = (pnlPoints / leg.entryPrice) * 100;
                            leg.pnlPoints = pnlPoints;
                            const quantity = leg.leg.lots * parseInt(leg.instrument.lotsize || 1);
                            leg.pnlRupees = pnlPoints * quantity;
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

                console.log(`Strategy ${strategyId}: Avg PnL%=${avgPnl.toFixed(2)}%, Total PnL ₹=${totalPnlRupees.toFixed(2)}`);

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

                        const closeConfig = {
                            ...config,
                            side: leg.leg.side === "BUY" ? "SELL" : "BUY",
                            variety: "NORMAL",
                            ordertype: "MARKET",
                            lots: leg.leg.lots
                        };
                        const orderData = await placeOrder(closeConfig, leg.instrument, config.connectionId);
                        leg.exited = true;
                        leg.exitOrderId = orderData.orderid;
                        leg.exitType = "OVERALL_STOP_LOSS";
                        return orderData.orderid;
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
                        if (leg.exited) continue;

                        const slVal = leg.leg.stop_loss || 0;
                        let isHit = false;
                        if (leg.leg.sl_type === "POINTS") {
                            isHit = leg.pnlPoints <= -slVal;
                        } else {
                            isHit = leg.pnlPercent <= -slVal;
                        }

                        if (isHit) {
                            console.log(`[${new Date().toISOString()}] Manual Stop Loss hit for leg ${leg.instrument.symbol}: PnL=${leg.pnlPercent.toFixed(2)}%`);
                            const closeConfig = {
                                ...config,
                                side: leg.leg.side === "BUY" ? "SELL" : "BUY",
                                variety: "NORMAL",
                                ordertype: "MARKET",
                                lots: leg.leg.lots
                            };
                            const orderData = await placeOrder(closeConfig, leg.instrument, config.connectionId);
                            leg.exited = true;
                            leg.exitOrderId = orderData.orderid;
                            leg.exitType = "LEG_STOP_LOSS";
                        }
                    }
                } else {
                    // Real Stop Loss handling for variety="STOPLOSS"
                    // Check if any exchange SL was hit
                    for (const leg of strategy.legs) {
                        if (leg.exited) continue;
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
                                            leg.exited = true;
                                            leg.exitType = "EXCHANGE_STOP_LOSS";
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

                    // 2. Place Market Exit Orders for remaining active legs
                    const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
                        if (leg.exited) return leg.exitOrderId;

                        const closeConfig = {
                            ...config,
                            side: leg.leg.side === "BUY" ? "SELL" : "BUY",
                            variety: "NORMAL",
                            ordertype: "MARKET",
                            lots: leg.leg.lots
                        };
                        const orderData = await placeOrder(closeConfig, leg.instrument, config.connectionId);
                        leg.exited = true;
                        leg.exitOrderId = orderData.orderid;
                        leg.exitType = "EXIT_TIME";
                        return orderData.orderid;
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
    const strategyId = `str_${Date.now()}`;
    const strategy = {
        id: strategyId,
        user_id: config.userId,
        config: config,
        status: "SAVED",
        created_at: new Date().toISOString(),
        final_pnl_percent: null,
        order_id: null,
        entry_price: null,
        instrument: null
    };
    savedStrategies.set(strategyId, strategy);
    return strategy;
}

async function updateStrategy(strategyId, config) {
    const existing = savedStrategies.get(strategyId);
    if (!existing) throw new Error("Strategy not found");
    if (existing.status !== "SAVED") {
        throw new Error("Only SAVED strategies can be modified");
    }
    const updated = {
        ...existing,
        config,
        updated_at: new Date().toISOString(),
    };
    savedStrategies.set(strategyId, updated);
    return updated;
}

async function deleteStrategy(strategyId) {
    const existing = savedStrategies.get(strategyId);
    if (!existing) throw new Error("Strategy not found");
    if (activeStrategies.has(strategyId)) {
        throw new Error("Cannot delete an active strategy");
    }
    savedStrategies.delete(strategyId);
    return true;
}

async function startStrategy(strategyId) {
    const strategy = savedStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (activeStrategies.has(strategyId)) {
        throw new Error("Strategy already running");
    }

    const runtimeStrategy = {
        id: strategyId,
        user_id: strategy.user_id,
        config: strategy.config,
        status: "WAITING",
        entryAttempted: false,
        startTime: new Date()
    };

    activeStrategies.set(strategyId, runtimeStrategy);

    updateStrategyInMemory(strategyId, { status: "WAITING" });
    executeStrategy(strategyId);

    return strategyId;
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

function getStatus(strategyId) {
    const s = activeStrategies.get(strategyId);
    if (!s) return null;

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
        instrument: s.instrument
    };
}

async function getUserStrategies(userId) {
    const all = Array.from(savedStrategies.values())
        .filter((s) => s.user_id === userId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return all;
}

function getActiveStrategies(userId) {
    const active = [];
    for (const [id, s] of activeStrategies.entries()) {
        if (s.user_id === userId && (s.status === "WAITING" || s.status === "IN_POSITION")) {
            active.push(getStatus(id));
        }
    }
    return active;
}

module.exports = {
    saveStrategy,
    updateStrategy,
    deleteStrategy,
    startStrategy,
    stopStrategy,
    getStatus,
    getUserStrategies,
    getActiveStrategies
};
