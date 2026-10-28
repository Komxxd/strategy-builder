const { getLtpSecure, getLtpWithRetry, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
const { getLegStrikeSelection, findClosestPremiumInstrument, findOptionInstrument, calculateSyntheticFuture, getATMStrike } = require("./strategy.instruments");
const { calculateMomentumTarget, checkMomentumHit } = require("./strategy.momentum");
const { getISTTime, getISTExchangeFormat } = require("./strategy.time");
const { getLimitOffsetAmt, roundToTick, computeStopLossExitPrices, resolveUniversalOrderParams } = require("./strategy.offset");
const { placeOrder, chaseOrderFill, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const marketSocketService = require("../marketSocket.service");
const { pauseStrategy } = require("./strategy.lifecycle");

async function resolveEntryCandleOpenPrice(leg, config, strategyId) {
    const isEnabled = leg.is_sl_price_on_candle_open || leg.sl_price_on_candle_open || leg.sl_based_on_candle_open || leg.leg?.is_sl_price_on_candle_open || leg.leg?.sl_price_on_candle_open || leg.leg?.sl_based_on_candle_open || config?.is_sl_price_on_candle_open || config?.sl_price_on_candle_open || config?.sl_based_on_candle_open;
    if (!isEnabled || leg.simpleMntmEnabled) {
        return leg.entryPrice;
    }
    const { getISTDateOnly, getISTTime } = require("./strategy.time");
    const today = getISTDateOnly();
    const timeStr = leg.entryTime || config.entry_time || getISTTime();
    const minute = timeStr.includes(" ") ? timeStr.split(" ")[1].substring(0, 5) : timeStr.substring(0, 5);

    let candleOpen = leg.entryCandleOpen || leg.candleOpen || leg.initialLtp || leg.entryPrice;
    let source = "Snapshot LTP";
    if (leg.candleOpen && leg.candleOpen > 0) {
        source = "Websocket Tick";
    }

    try {
        const marketService = require("../market.service");
        const fetchPromise = marketService.getHistoricalData({
            exchange: leg.instrument.exch_seg,
            symboltoken: leg.instrument.token,
            interval: "ONE_MINUTE",
            fromdate: `${today} ${minute}`,
            todate: `${today} ${minute}`,
            connectionId: config.connectionId
        });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Candle fetch timeout")), 2000));
        const res = await Promise.race([fetchPromise, timeoutPromise]);

        if (res && res.status && Array.isArray(res.data) && res.data.length > 0) {
            const openVal = parseFloat(res.data[0][1]);
            if (openVal > 0) {
                candleOpen = openVal;
                source = "Exchange Candle API";
            }
        }
    } catch (e) {
        // Fall back to leg.entryCandleOpen / leg.candleOpen / leg.initialLtp
    }

    if (!candleOpen || candleOpen <= 0) {
        candleOpen = leg.entryPrice;
        source = "Traded Fill Price Fallback";
    }

    leg.entryCandleOpen = candleOpen;
    leg.candleOpen = candleOpen;
    leg.entryCandleOpenSource = source;

    if (strategyId) {
        addStrategyLog(strategyId, `[SL Price on Entry Candle Open] Resolved Entry Candle (${minute}) Open Price for ${leg.instrument.symbol}: ₹${Number(candleOpen).toFixed(2)} [Source: ${source}]. Traded Entry Price: ₹${Number(leg.entryPrice || 0).toFixed(2)}.`, "INFO");
    }

    return candleOpen;
}

async function handleInitialEntry(strategyId, strategy) {
    if (strategy.entryAttempted) return;
    strategy.entryAttempted = true;

    const { config } = strategy;
    const isVirtualStrategy = strategy.is_virtual === true || config.is_virtual === true;

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

        const ltpRes = await getLtpSecure({
            exchange: indexExchange,
            symboltoken: indexToken,
            connectionId: config.connectionId
        });

        if (!ltpRes.status || !ltpRes.data?.fetched?.[0]) {
             strategy.entryAttempted = false; // Allow retry next tick
             return;
        }

        const spotPrice = ltpRes.data.fetched[0].ltp;
        addStrategyLog(strategyId, `Entry condition met. Spot Price for ${config.index}: ₹${spotPrice}. Identifying strikes...`, "INFO");
        
        const legs = config.legs || [];
        const resolvedLegs = [];
        for (const leg of legs) {
            let targetInstrument = null;
            if (leg.strike_criteria === 'CLOSEST_PREMIUM') {
                targetInstrument = await findClosestPremiumInstrument(config.index, leg.option_type, leg.premium, config.connectionId, leg.expiry_type);
            } else if (leg.strike_criteria === 'SYNTHETIC_FUTURE') {
                // Step 1: Calculate Synthetic Future using the current spot price to get ATM CE/PE
                const sfPrice = await calculateSyntheticFuture(config.index, spotPrice, config.connectionId, leg.expiry_type);
                // Step 2: Use the synthetic future price as the new "spot" to calculate the target strike
                const { targetStrike: sfStrike, strikeLabel } = getLegStrikeSelection({
                    index: config.index, option_type: leg.option_type,
                    strike: leg.strike, spotPrice: sfPrice
                });
                addStrategyLog(strategyId, `Leg ${resolvedLegs.length + 1}: Synthetic Future = ₹${sfPrice.toFixed(2)}, selecting ${strikeLabel} (${leg.option_type}) at Strike ${sfStrike}.`, "INFO");
                targetInstrument = await findOptionInstrument(config.index, leg.option_type, sfStrike, leg.expiry_type);
            } else {
                const { targetStrike, strikeLabel } = getLegStrikeSelection({
                    index: config.index,
                    option_type: leg.option_type,
                    strike: leg.strike,
                    spotPrice
                });
                addStrategyLog(strategyId, `Leg ${resolvedLegs.length + 1}: Selecting ${strikeLabel} (${leg.option_type}) at Strike ${targetStrike}.`, "INFO");
                targetInstrument = await findOptionInstrument(config.index, leg.option_type, targetStrike, leg.expiry_type);
            }
            if (!targetInstrument) {
                throw new Error(`Could not find ${leg.option_type} instrument with expiry ${leg.expiry_type || 'weekly'}`);
            }
            resolvedLegs.push({ leg, instrument: targetInstrument });
        }

        // Proactive WebSocket Subscription
        const tokensByExch = {};
        resolvedLegs.forEach(item => {
            const exch = item.instrument.exch_seg;
            if (!tokensByExch[exch]) tokensByExch[exch] = [];
            tokensByExch[exch].push(item.instrument.token);
        });
        Object.keys(tokensByExch).forEach(exch => {
            marketSocketService.subscribeTokens(exch, tokensByExch[exch], config.connectionId);
        });

        strategy.legs = []; 

        const placedLegs = await Promise.all(resolvedLegs.map(async (item, idx) => {
            let finalPrice = (config.price || "0").toString();
            let orderData = null;
            const isSimpleMntm = item.leg.simple_mntm_enabled === true;
            let legState = "ACTIVE";
            let roundedMntmTarget = null;

            const instLtp = await getLtpWithRetry({
                exchange: item.instrument.exch_seg,
                symboltoken: item.instrument.token,
                connectionId: config.connectionId
            });

            if (!instLtp || instLtp <= 0) {
                pauseStrategy(strategyId, `Entry LTP Read Failed for ${item.instrument.symbol} after retries.`);
                throw new Error(`CRITICAL: Cannot place entry order for ${item.instrument.symbol}. LTP missing.`);
            }

            if (isVirtualStrategy) {
                if (isSimpleMntm) {
                    roundedMntmTarget = calculateMomentumTarget(instLtp, item.leg);
                    legState = "WAITING_FOR_SIMPLE_MNTM";
                    const mntmType = item.leg.simple_mntm_type || "NORMAL";
                    addStrategyLog(strategyId, `[VIRTUAL] Simple Mntm (${mntmType}) enabled for ${item.instrument.symbol}. Snapshot: ₹${instLtp}. Initial Target: ₹${roundedMntmTarget}...`, "INFO");
                    orderData = {
                        orderid: `VIRTUAL-SIMPLE-${Date.now()}_${idx}`,
                        uniqueorderid: `UVIRTUAL-SIMPLE-${Date.now()}_${idx}`,
                        mntmTargetPrice: roundedMntmTarget,
                        baseOtp: instLtp
                    };
                } else {
                    finalPrice = instLtp.toString();
                    legState = "VIRTUAL_MONITORING";
                    orderData = {
                        orderid: `VIRTUAL-${Date.now()}_${idx}`,
                        uniqueorderid: `UVIRTUAL-${Date.now()}_${idx}`
                    };
                    addStrategyLog(strategyId, `[VIRTUAL] Initial entry created for ${item.instrument.symbol} at ₹${instLtp}. Virtual monitoring active.`, "INFO");
                }
            } else if (isSimpleMntm) {
                roundedMntmTarget = calculateMomentumTarget(instLtp, item.leg);
                const mntmType = item.leg.simple_mntm_type || "NORMAL";
                const isHighOrLow = mntmType === "HIGH" || mntmType === "LOW";

                if (config.is_paper_trading || isHighOrLow) {
                    legState = "WAITING_FOR_SIMPLE_MNTM";
                    const prefix = config.is_paper_trading ? "[PAPER]" : "[LIVE]";
                    addStrategyLog(strategyId, `${prefix} Simple Mntm (${mntmType}) enabled for ${item.instrument.symbol}. Snapshot: ₹${instLtp}. Initial Target: ₹${roundedMntmTarget}...`, "INFO");
                    orderData = {
                        orderid: `${config.is_paper_trading ? 'V' : 'LIVE'}-SIMPLE-${Date.now()}_${idx}`,
                        uniqueorderid: `${config.is_paper_trading ? 'VU' : 'ULIVE'}-SIMPLE-${Date.now()}_${idx}`,
                        mntmTargetPrice: roundedMntmTarget,
                        baseOtp: instLtp
                    };
                } else {
                    const offsetAmt = getLimitOffsetAmt(roundedMntmTarget, config);
                    const { variety, ordertype, price, triggerprice } = resolveUniversalOrderParams({
                        targetPrice: roundedMntmTarget,
                        currentLtp: instLtp,
                        side: item.leg.side,
                        offset: offsetAmt
                    });
                    try {
                        orderData = await placeOrder({ ...config, variety, ordertype, side: item.leg.side, lots: item.leg.lots, price, triggerprice }, item.instrument, config.connectionId);
                        legState = "WAITING_FOR_FILL"; 
                    } catch (err) {
                        if (err.message === "LPP_TRIGGER_REJECTION") {
                            addStrategyLog(strategyId, `[LIVE] Mntm order rejected by LPP for ${item.instrument.symbol}. Falling back to INTERNAL MONITORING for Target: ₹${roundedMntmTarget}.`, "WARNING");
                            legState = "WAITING_FOR_INTERNAL_FALLBACK";
                            orderData = {
                                orderid: `INTERNAL-LPP-${Date.now()}`,
                                uniqueorderid: `UINTERNAL-LPP-${Date.now()}`,
                            };
                            leg.fallbackTargetPrice = roundedMntmTarget;
                            leg.fallbackSide = item.leg.side;
                            leg.fallbackBaseOtp = instLtp;
                        } else {
                            throw err;
                        }
                    }                }
            } else {
                if (config.ordertype === 'LIMIT') {
                    const offsetAmt = getLimitOffsetAmt(instLtp, config);
                    if (item.leg.side === "BUY") finalPrice = roundToTick(instLtp + offsetAmt).toString();
                    else finalPrice = roundToTick(instLtp - offsetAmt).toString();
                }
                orderData = await placeOrder({ ...config, variety: config.variety === "STOPLOSS" ? "NORMAL" : (config.variety || "NORMAL"), side: item.leg.side, lots: item.leg.lots, price: finalPrice }, item.instrument, config.connectionId);
                addStrategyLog(strategyId, `Placed ${item.leg.side} order for ${item.instrument.symbol}.`, "INFO");
                legState = "ACTIVE";
            }

            const leg = {
                ...item,
                orderId: orderData.orderid,
                uniqueOrderId: orderData.uniqueorderid,
                mntmTargetPrice: roundedMntmTarget,
                baseOtp: orderData.baseOtp || instLtp,
                simpleMntmEnabled: isSimpleMntm,
                legIndex: idx,
                state: legState,
                is_virtual_monitoring: isVirtualStrategy,
                is_virtual_leg: isVirtualStrategy,
                original_traded_price: parseFloat(finalPrice) || instLtp || 0,
                initialLtp: instLtp,
                entryCandleOpen: instLtp,
                candleOpen: instLtp,
                candleMinute: (config.entry_time || getISTTime()).substring(0, 5),
                base_otp: parseFloat(finalPrice) || instLtp || 0,
                recost_trigger_price: null,
                reentry_count: 0,
                last_tick_price: null,
                max_peak_price: (item.leg.simple_mntm_type === "HIGH" && isSimpleMntm) ? instLtp : null,
                max_low_price: (item.leg.simple_mntm_type === "LOW" && isSimpleMntm) ? instLtp : null,
                re_high_trigger_price: (item.leg.simple_mntm_type === "HIGH" && isSimpleMntm) ? roundedMntmTarget : null,
                re_low_trigger_price: (item.leg.simple_mntm_type === "LOW" && isSimpleMntm) ? roundedMntmTarget : null,
                rtp: ((item.leg.simple_mntm_type === "HIGH" || item.leg.simple_mntm_type === "LOW") && isSimpleMntm) ? roundedMntmTarget : null,
                bookedPnlPoints: 0,
                bookedPnlRupees: 0,
                currentActivePnlPoints: 0,
                currentActivePnlRupees: 0,
                entryPrice: (isVirtualStrategy && !isSimpleMntm) ? instLtp : null,
                entryTime: (isVirtualStrategy && !isSimpleMntm) ? getISTExchangeFormat() : null,
                peakPrice: (isVirtualStrategy && !isSimpleMntm) ? instLtp : null,
                tslReferencePrice: (isVirtualStrategy && !isSimpleMntm) ? instLtp : null,
                currentLtp: instLtp,
                pnlPercent: 0,
                pnlPoints: 0,
                pnlRupees: 0,
                slOrderId: null,
                slUniqueOrderId: null,
                slTriggerPrice: null,
                slLimitPrice: null,
                is_sl_price_on_candle_open: !!(item.leg?.is_sl_price_on_candle_open || item.leg?.sl_price_on_candle_open || item.leg?.sl_based_on_candle_open || config?.is_sl_price_on_candle_open || config?.sl_price_on_candle_open || config?.sl_based_on_candle_open)
            };

            if (isVirtualStrategy && leg.entryPrice && config.variety === "STOPLOSS" && leg.leg.sl_enabled !== false) {
                let basePriceForSl = leg.entryPrice;
                const isSlCandleOpen = (leg.is_sl_price_on_candle_open || leg.leg?.is_sl_price_on_candle_open || leg.leg?.sl_price_on_candle_open || leg.leg?.sl_based_on_candle_open || config?.is_sl_price_on_candle_open || config?.sl_price_on_candle_open || config?.sl_based_on_candle_open) && !leg.simpleMntmEnabled;
                if (isSlCandleOpen) {
                    basePriceForSl = leg.entryCandleOpen || leg.candleOpen || leg.initialLtp || leg.entryPrice;
                    leg.entryCandleOpen = basePriceForSl;
                }
                const prices = computeStopLossExitPrices(
                    basePriceForSl,
                    leg.leg.side,
                    leg.leg.sl_type || "PERCENTAGE",
                    leg.leg.stop_loss,
                    getLimitOffsetAmt(basePriceForSl, config),
                    config.entry_limit_offset_type || 'POINTS'
                );
                leg.slTriggerPrice = prices?.trigger || null;
                leg.initialSlTriggerPrice = prices?.trigger || null;
                leg.slLimitPrice = prices?.limit || null;
                if (isSlCandleOpen) {
                    addStrategyLog(strategyId, `[VIRTUAL][SL Price on Entry Candle Open] Calculated Stop-Loss for ${leg.instrument.symbol}: Entry Candle Open ₹${Number(basePriceForSl).toFixed(2)} (vs Entry Price ₹${Number(leg.entryPrice).toFixed(2)}) → Trigger: ₹${prices?.trigger}`, "INFO");
                }
            }

            strategy.legs.push(leg);
            return leg;
        }));

        await Promise.all(placedLegs.map(async (leg) => {
            if (isVirtualStrategy) return;
            
            if (leg.uniqueOrderId) {
                addStrategyLog(strategyId, `[Success] Angel one API returned a full response for ${leg.instrument.symbol}.`, "INFO");
            } else {
                addStrategyLog(strategyId, `[ERROR] Angel One API returned a partial response (missing Unique Order ID) for ${leg.instrument.symbol}. Retrying entry...`, "ERROR");
                
                try {
                    const { placeOrder } = require("./strategy.execution");
                    const { getLimitOffsetAmt, roundToTick } = require("./strategy.offset");
                    
                    let finalPrice = config.price || "0";
                    if (config.ordertype === 'LIMIT') {
                        const offsetAmt = getLimitOffsetAmt(leg.initialLtp, config);
                        if (leg.leg.side === "BUY") finalPrice = roundToTick(leg.initialLtp + offsetAmt).toString();
                        else finalPrice = roundToTick(leg.initialLtp - offsetAmt).toString();
                    }
                    
                    const orderData = await placeOrder({ ...config, variety: config.variety === "STOPLOSS" ? "NORMAL" : (config.variety || "NORMAL"), side: leg.leg.side, lots: leg.leg.lots, price: finalPrice }, leg.instrument, config.connectionId);
                    
                    if (orderData.uniqueorderid) {
                        leg.orderId = orderData.orderid;
                        leg.uniqueOrderId = orderData.uniqueorderid;
                        addStrategyLog(strategyId, `[Retry Success] Placed ${leg.leg.side} order for ${leg.instrument.symbol}.`, "INFO");
                    } else {
                        addStrategyLog(strategyId, `[CRITICAL] Retry failed: Angel One API returned a partial response again for ${leg.instrument.symbol}.`, "ERROR");
                        leg.state = "ERROR";
                        return;
                    }
                } catch (err) {
                    addStrategyLog(strategyId, `[CRITICAL] Retry failed for ${leg.instrument.symbol}: ${err.message}`, "ERROR");
                    leg.state = "ERROR";
                    return;
                }
            }

            if (leg.uniqueOrderId) {
                if (leg.state === "WAITING_FOR_SIMPLE_MNTM") return;
                if (leg.state === "WAITING_FOR_INTERNAL_FALLBACK") return;

                if (leg.state === "WAITING_FOR_FILL" && leg.simpleMntmEnabled) {
                    // Background live order monitoring for simple momentum to prevent blocking init
                    setTimeout(async () => {
                        try {
                            const { waitForOrderFillPrice } = require("./strategy.execution");
                            const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
                            const isPaperTrading = config?.is_paper_trading === true || isVirtual;
                            const fillMeta = {};
                            const fillPrice = await waitForOrderFillPrice(
                                leg.uniqueOrderId,
                                config.connectionId,
                                isPaperTrading,
                                leg.instrument,
                                28800000, // 8 hours timeout for live momentum limit orders
                                2000,
                                {
                                    side: leg.leg.side,
                                    ordertype: config.ordertype,
                                    price: parseFloat(leg.original_traded_price || config.price || 0),
                                    triggerprice: parseFloat(leg.mntmTargetPrice || config.triggerprice || 0),
                                    isInstantFill: true
                                },
                                fillMeta
                            );
                            if (fillPrice) {
                                leg.entryPrice = fillPrice;
                                leg.entryTime = fillMeta.time || getISTExchangeFormat();
                                leg.original_traded_price = fillPrice;
                                leg.base_otp = fillPrice;
                                leg.peakPrice = fillPrice;
                                leg.tslReferencePrice = fillPrice;
                                leg.state = "ACTIVE";
                                addStrategyLog(strategyId, `${leg.instrument.symbol} order filled at ₹${fillPrice}.`, "INFO");

                                if (config.variety === "STOPLOSS" && leg.leg.sl_enabled !== false) {
                                    const { placeStopLossWithRetry } = require("./strategy.execution");
                                    const { computeStopLossExitPrices, getLimitOffsetAmt } = require("./strategy.offset");
                                    let slValueToUse = leg.leg.stop_loss;
                                    if (leg.leg.sl_multiplier_entry_candle && leg.leg.sl_multiplier_value) {
                                        slValueToUse = leg.leg.stop_loss * parseFloat(leg.leg.sl_multiplier_value);
                                        leg.sl_multiplier_applied = true;
                                    }
                                    const slOrder = await placeStopLossWithRetry({
                                        baseConfig: config,
                                        legSide: leg.leg.side,
                                        entryPrice: leg.entryPrice,
                                        instrument: leg.instrument,
                                        lots: leg.leg.lots,
                                        slType: leg.leg.sl_type || "PERCENTAGE",
                                        slValue: slValueToUse,
                                        slLimitMargin: getLimitOffsetAmt(leg.entryPrice, config),
                                        slLimitMarginType: 'POINTS',
                                        connectionId: config.connectionId,
                                        strategyId: strategyId
                                    });
                                    const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", slValueToUse, getLimitOffsetAmt(leg.entryPrice, config), 'POINTS');
                                    if (slOrder?.orderid) {
                                        leg.slOrderId = slOrder.orderid;
                                        leg.slUniqueOrderId = slOrder.uniqueorderid;
                                    }
                                    leg.slTriggerPrice = prices?.trigger || null;
                                    leg.initialSlTriggerPrice = prices?.trigger || null;
                                    leg.slLimitPrice = prices?.limit || null;
                                }
                            } else {
                                addStrategyLog(strategyId, `Warning: Fill price not detected for ${leg.instrument.symbol}. Position will NOT be protected with a Stop-Loss.`, "ERROR");
                            }
                        } catch (e) { console.error("Error background simple mntm", e); }
                    }, 0);
                    return;
                }

                let fillPrice;
                const fillMeta = {};
                if (!config.is_paper_trading && config.ordertype === 'LIMIT' && !leg.simpleMntmEnabled) {
                    fillPrice = await chaseOrderFill({
                        orderId: leg.orderId,
                        uniqueOrderId: leg.uniqueOrderId,
                        instrument: leg.instrument,
                        config,
                        legSide: leg.leg.side,
                        lots: leg.leg.lots,
                        connectionId: config.connectionId,
                        strategyId,
                        baseLtp: leg.initialLtp,
                        fillMeta
                    });
                } else {
                    const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
                    const isPaperTrading = config?.is_paper_trading === true || isVirtual;
                    fillPrice = await waitForOrderFillPrice(
                        leg.uniqueOrderId,
                        config.connectionId,
                        isPaperTrading,
                        leg.instrument,
                        60000,
                        2000,
                        {
                            side: leg.leg.side,
                            ordertype: config.ordertype,
                            price: parseFloat(leg.original_traded_price || config.price || 0),
                            triggerprice: parseFloat(leg.mntmTargetPrice || config.triggerprice || 0),
                            isInstantFill: true
                        },
                        fillMeta
                    );
                }
                if (fillPrice) {
                    leg.entryPrice = fillPrice;
                    leg.entryTime = fillMeta.time || getISTExchangeFormat();
                    leg.original_traded_price = fillPrice;
                    leg.base_otp = fillPrice;
                    leg.peakPrice = fillPrice;
                    leg.tslReferencePrice = fillPrice;
                    leg.state = "ACTIVE";
                    addStrategyLog(strategyId, `${leg.instrument.symbol} order filled at ₹${fillPrice}.`, "INFO");
                } else if (!config.is_paper_trading && config.ordertype === 'LIMIT' && !leg.simpleMntmEnabled) {
                    const { stopStrategy } = require("./strategy.lifecycle");
                    stopStrategy(strategyId, `Entry Chase failed for ${leg.instrument?.symbol || 'leg'}: ${leg.instrument.symbol} order not filled after ${parseInt(config.chase_time_seconds) || 45}s chase.`);
                    return;
                } else {
                    addStrategyLog(strategyId, `Warning: Fill price not detected for ${leg.instrument.symbol}. Position will NOT be protected with a Stop-Loss.`, "ERROR");
                }
            }

            if (config.variety === "STOPLOSS" && leg.entryPrice && leg.leg.sl_enabled !== false) {
                let slValueToUse = leg.leg.stop_loss;
                if (leg.leg.sl_multiplier_entry_candle && leg.leg.sl_multiplier_value) {
                    slValueToUse = leg.leg.stop_loss * parseFloat(leg.leg.sl_multiplier_value);
                    leg.sl_multiplier_applied = true;
                }
                const isSlCandleOpen = (leg.is_sl_price_on_candle_open || leg.leg?.is_sl_price_on_candle_open || leg.leg?.sl_price_on_candle_open || leg.leg?.sl_based_on_candle_open || config?.is_sl_price_on_candle_open || config?.sl_price_on_candle_open || config?.sl_based_on_candle_open) && !leg.simpleMntmEnabled;
                let basePriceForSl = leg.entryPrice;
                if (isSlCandleOpen) {
                    basePriceForSl = await resolveEntryCandleOpenPrice(leg, config, strategyId);
                }
                const slLimitMargin = getLimitOffsetAmt(basePriceForSl, config);
                const slOrder = await placeStopLossWithRetry({
                    baseConfig: config,
                    legSide: leg.leg.side,
                    entryPrice: basePriceForSl,
                    instrument: leg.instrument,
                    lots: leg.leg.lots,
                    slType: leg.leg.sl_type || "PERCENTAGE",
                    slValue: slValueToUse,
                    slLimitMargin: slLimitMargin,
                    slLimitMarginType: 'POINTS',
                    connectionId: config.connectionId,
                    strategyId: strategyId,
                    isCandleOpenSl: isSlCandleOpen,
                    candleOpenPrice: basePriceForSl,
                    actualEntryPrice: leg.entryPrice
                });
                const prices = computeStopLossExitPrices(basePriceForSl, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", slValueToUse, slLimitMargin, 'POINTS');
                if (slOrder?.orderid) {
                    leg.slOrderId = slOrder.orderid;
                    leg.slUniqueOrderId = slOrder.uniqueorderid;
                }
                leg.slTriggerPrice = prices?.trigger || null;
                leg.initialSlTriggerPrice = prices?.trigger || null;
                leg.slLimitPrice = prices?.limit || null;
                if (isSlCandleOpen) {
                    addStrategyLog(strategyId, `[SL Price on Entry Candle Open] Calculated Stop-Loss for ${leg.instrument.symbol}: Entry Candle Open ₹${Number(basePriceForSl).toFixed(2)} (vs Traded Entry ₹${Number(leg.entryPrice).toFixed(2)}) → Trigger: ₹${prices?.trigger}, Limit: ₹${prices?.limit}`, "INFO");
                }
            }
        }));

        strategy.status = "IN_POSITION";
        if (isVirtualStrategy) strategy.is_virtual = true;
        updateStrategyInMemory(strategyId, {
            status: "IN_POSITION",
            is_virtual: isVirtualStrategy,
            order_id: strategy.legs.map(l => l.orderId),
            entry_price: strategy.legs.map(l => l.entryPrice),
            instrument: strategy.legs.map(l => l.instrument)
        });

    } catch (err) {
        console.error(`[${strategyId}] Initial entry failed:`, err.message);
        throw err; // Allow executeStrategy to handle rollback
    }
}

module.exports = {
   handleInitialEntry,
   resolveEntryCandleOpenPrice
};
