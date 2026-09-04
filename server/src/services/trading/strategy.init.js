const { getLtpSecure, getLtpWithRetry, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
const { getLegStrikeSelection, findClosestPremiumInstrument, findOptionInstrument, calculateSyntheticFuture, getATMStrike } = require("./strategy.instruments");
const { calculateMomentumTarget, checkMomentumHit } = require("./strategy.momentum");
const { getISTTime, getISTExchangeFormat } = require("./strategy.time");
const { getLimitOffsetAmt, roundToTick, computeStopLossExitPrices, resolveUniversalOrderParams } = require("./strategy.offset");
const { placeOrder, chaseOrderFill, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const marketSocketService = require("../marketSocket.service");
const { pauseStrategy } = require("./strategy.lifecycle");

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
                // Step 1: Get the reference strike from spot using normal OTM/ITM logic
                const { targetStrike: refStrike, strikeLabel } = getLegStrikeSelection({
                    index: config.index, option_type: leg.option_type,
                    strike: leg.strike, spotPrice
                });
                // Step 2: Calculate Synthetic Future at that strike (SF = Strike + CE@Strike - PE@Strike)
                const sfPrice = await calculateSyntheticFuture(config.index, refStrike, config.connectionId, leg.expiry_type);
                // Step 3: Round SF to nearest valid strike
                const sfStrike = getATMStrike(config.index, sfPrice);
                addStrategyLog(strategyId, `Leg ${resolvedLegs.length + 1}: Synthetic Future @ ${refStrike} (${strikeLabel}) = ₹${sfPrice.toFixed(2)} → Strike ${sfStrike} (${leg.option_type})`, "INFO");
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
                    addStrategyLog(strategyId, `[VIRTUAL] Simple Mntm enabled for ${item.instrument.symbol}. Snapshot: ₹${instLtp}. Waiting for Target: ₹${roundedMntmTarget}...`, "INFO");
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
                const offsetAmt = getLimitOffsetAmt(roundedMntmTarget, config);

                if (config.is_paper_trading) {
                    legState = "WAITING_FOR_SIMPLE_MNTM";
                    addStrategyLog(strategyId, `[PAPER] Simple Mntm enabled for ${item.instrument.symbol}. Snapshot: ₹${instLtp}. Waiting for Target: ₹${roundedMntmTarget}...`, "INFO");
                    orderData = {
                        orderid: `V-SIMPLE-${Date.now()}`,
                        uniqueorderid: `VU-SIMPLE-${Date.now()}`,
                        mntmTargetPrice: roundedMntmTarget,
                        baseOtp: instLtp
                    };
                } else {
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
                base_otp: parseFloat(finalPrice) || instLtp || 0,
                recost_trigger_price: null,
                reentry_count: 0,
                last_tick_price: null,
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
                slLimitPrice: null
            };

            if (isVirtualStrategy && leg.entryPrice && config.variety === "STOPLOSS" && leg.leg.sl_enabled !== false) {
                const prices = computeStopLossExitPrices(
                    leg.entryPrice,
                    leg.leg.side,
                    leg.leg.sl_type || "PERCENTAGE",
                    leg.leg.stop_loss,
                    getLimitOffsetAmt(leg.entryPrice, config),
                    config.entry_limit_offset_type || 'POINTS'
                );
                leg.slTriggerPrice = prices?.trigger || null;
                leg.initialSlTriggerPrice = prices?.trigger || null;
                leg.slLimitPrice = prices?.limit || null;
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
                                }
                            );
                            if (fillPrice) {
                                leg.entryPrice = fillPrice;
                                leg.entryTime = getISTExchangeFormat();
                                leg.original_traded_price = fillPrice;
                                leg.base_otp = fillPrice;
                                leg.peakPrice = fillPrice;
                                leg.tslReferencePrice = fillPrice;
                                leg.state = "ACTIVE";
                                addStrategyLog(strategyId, `${leg.instrument.symbol} order filled at ₹${fillPrice}.`, "INFO");

                                if (config.variety === "STOPLOSS" && leg.leg.sl_enabled !== false) {
                                    const { placeStopLossWithRetry } = require("./strategy.execution");
                                    const { computeStopLossExitPrices, getLimitOffsetAmt } = require("./strategy.offset");
                                    const slOrder = await placeStopLossWithRetry({
                                        baseConfig: config,
                                        legSide: leg.leg.side,
                                        entryPrice: leg.entryPrice,
                                        instrument: leg.instrument,
                                        lots: leg.leg.lots,
                                        slType: leg.leg.sl_type || "PERCENTAGE",
                                        slValue: leg.leg.stop_loss,
                                        slLimitMargin: getLimitOffsetAmt(leg.entryPrice, config),
                                        slLimitMarginType: 'POINTS',
                                        connectionId: config.connectionId,
                                        strategyId: strategyId
                                    });
                                    const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss, getLimitOffsetAmt(leg.entryPrice, config), 'POINTS');
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
                        baseLtp: leg.initialLtp
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
                        }
                    );
                }
                if (fillPrice) {
                    leg.entryPrice = fillPrice;
                    leg.entryTime = getISTExchangeFormat();
                    leg.original_traded_price = fillPrice;
                    leg.base_otp = fillPrice;
                    leg.peakPrice = fillPrice;
                    leg.tslReferencePrice = fillPrice;
                    leg.state = "ACTIVE";
                    addStrategyLog(strategyId, `${leg.instrument.symbol} order filled at ₹${fillPrice}.`, "INFO");
                } else if (!config.is_paper_trading && config.ordertype === 'LIMIT' && !leg.simpleMntmEnabled) {
                    const { stopStrategy } = require("./strategy.lifecycle");
                    stopStrategy(strategyId, `Entry Chase failed for ${leg.instrument?.symbol || 'leg'}: ${leg.instrument.symbol} order not filled after 45s chase.`);
                    return;
                } else {
                    addStrategyLog(strategyId, `Warning: Fill price not detected for ${leg.instrument.symbol}. Position will NOT be protected with a Stop-Loss.`, "ERROR");
                }
            }

            if (config.variety === "STOPLOSS" && leg.entryPrice && leg.leg.sl_enabled !== false) {
                const slOrder = await placeStopLossWithRetry({
                    baseConfig: config,
                    legSide: leg.leg.side,
                    entryPrice: leg.entryPrice,
                    instrument: leg.instrument,
                    lots: leg.leg.lots,
                    slType: leg.leg.sl_type || "PERCENTAGE",
                    slValue: leg.leg.stop_loss,
                    slLimitMargin: getLimitOffsetAmt(leg.entryPrice, config),
                    slLimitMarginType: 'POINTS',
                    connectionId: config.connectionId,
                    strategyId: strategyId
                });
                const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss, getLimitOffsetAmt(leg.entryPrice, config), 'POINTS');
                if (slOrder?.orderid) {
                    leg.slOrderId = slOrder.orderid;
                    leg.slUniqueOrderId = slOrder.uniqueorderid;
                }
                leg.slTriggerPrice = prices?.trigger || null;
                leg.initialSlTriggerPrice = prices?.trigger || null;
                leg.slLimitPrice = prices?.limit || null;
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
   handleInitialEntry
};
