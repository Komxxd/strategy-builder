const { getLtpSecure, getLtpWithRetry, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
const { getLegStrikeSelection, findClosestPremiumInstrument, findOptionInstrument } = require("./strategy.instruments");
const { calculateMomentumTarget, checkMomentumHit } = require("./strategy.momentum");
const { getISTTime } = require("./strategy.time");
const { getLimitOffsetAmt, roundToTick, computeStopLossExitPrices, resolveUniversalOrderParams } = require("./strategy.offset");
const { placeOrder, chaseOrderFill, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const marketSocketService = require("../marketSocket.service");
const { pauseStrategy } = require("./strategy.lifecycle");

async function handleInitialEntry(strategyId, strategy) {
    if (strategy.entryAttempted) return;
    strategy.entryAttempted = true;

    const { config } = strategy;

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
            marketSocketService.subscribeTokens(exch, tokensByExch[exch]);
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

            if (isSimpleMntm) {
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
                original_traded_price: parseFloat(finalPrice) || 0,
                initialLtp: instLtp,
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
            strategy.legs.push(leg);
            return leg;
        }));

        await Promise.all(placedLegs.map(async (leg) => {
            if (leg.uniqueOrderId) {
                if (leg.state === "WAITING_FOR_SIMPLE_MNTM") return;

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
                    fillPrice = await waitForOrderFillPrice(
                        leg.uniqueOrderId,
                        config.connectionId,
                        config.is_paper_trading === true,
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
                    leg.entryTime = getISTTime();
                    leg.original_traded_price = fillPrice;
                    leg.base_otp = fillPrice;
                    leg.peakPrice = fillPrice;
                    leg.tslReferencePrice = fillPrice;
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
        updateStrategyInMemory(strategyId, {
            status: "IN_POSITION",
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
