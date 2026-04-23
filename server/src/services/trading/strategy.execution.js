/**
 * STRATEGY EXECUTION SERVICE
 * ==========================
 * This file is the "Arms and Legs" of the system. 
 * It is the only place that actually sends orders to the Stock Exchange (Angel One) 
 * or "fakes" them for Paper Trading.
 * 
 * Key Features:
 * 1. PAPER TRADING: Simulates order fills in memory without using real money.
 * 2. LIVE TRADING: Connects to SmartAPI (Angel One) to place real orders.
 * 3. ORDER CHASING: Because we use LIMIT orders (required by SEBI), the system
 *    automatically "chases" the price to make sure you get a fill.
 * 4. SL RETRY: If a Stop-Loss order fails to place, it tries again 3 times to protect your capital.
 */

const { getAuthorizedInstance } = require("../../config/smartapi");
const marketService = require("../market.service");
const marketSocketService = require("../marketSocket.service");
const { getLtpSecure, addStrategyLog } = require("./strategy.state");
const { getISTTime } = require("./strategy.time");
const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices, resolveUniversalOrderParams } = require("./strategy.offset");
const { checkOrderFillOnce, chaseOrderFill } = require("./strategy.chase");


/**
 * The primary function to place an order (Entry or Exit).
 */
async function placeOrder(config, instrument, connectionId) {
    const isPaperTrading = config.is_paper_trading === true;
    const connId = connectionId || config.connectionId;

    // We build the parameters exactly as the Broker (Angel One) expects them.
    const orderParams = {
        variety: config.variety || "NORMAL",
        tradingsymbol: instrument.symbol,
        symboltoken: instrument.token,
        transactiontype: config.side || "BUY",
        exchange: instrument.exch_seg,
        ordertype: config.ordertype || "LIMIT",
        producttype: config.producttype || "INTRADAY",
        duration: config.duration || "DAY",
        price: (config.price || "0").toString(),
        triggerprice: (config.triggerprice || "0").toString(),
        squareoff: (config.squareoff || "0").toString(),
        stoploss: (config.stoploss || "0").toString(),
        quantity: (config.lots * parseInt(instrument.lotsize)).toString(),
        scripconsent: "yes"
    };

    // --- CASE A: PAPER TRADING ---
    if (isPaperTrading) {
        console.log(`[PAPER_TRADE] Simulating order for ${instrument.symbol}`);
        return {
            orderid: `PAPER_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            uniqueorderid: `UPAPER_${Date.now()}_${Math.floor(Math.random() * 10000)}`
        };
    }

    // --- CASE B: LIVE TRADING ---
    try {
        console.log(`[LIVE_TRADE] Placing real order for ${instrument.symbol}`);
        const api = await getAuthorizedInstance(connId);
        const response = await api.placeOrder(orderParams);
        if (response.status && response.data) {
            return response.data; // contains real orderid and uniqueorderid
        }
        throw new Error(response.message || "Order placement failed");
    } catch (error) {
        console.error(`[LIVE_TRADE] CRITICAL ERROR:`, error);
        throw error;
    }
}


async function waitForOrderFillPrice(uniqueOrderId, connectionId, isPaperTrading = false, instrument = null, timeoutMs = 60000, pollMs = 2000, paperConfig = null) {
    if (isPaperTrading) {
        const { globalLtpMap } = require("./strategy.state");
        const start = Date.now();
        const pollInterval = pollMs || 1000;

        // Ensure we have paperConfig (it's essential for simulation logic)
        if (!paperConfig) {
            console.warn("[PAPER_SIM] No paperConfig provided. Falling back to instant fill.");
            const key = instrument ? `${instrument.exch_seg}_${instrument.token}` : null;
            return globalLtpMap[key] || null;
        }

        const { side, ordertype, price, triggerprice } = paperConfig;
        const target = (triggerprice > 0) ? triggerprice : price;
        const instrumentKey = instrument ? `${instrument.exch_seg}_${instrument.token}` : null;

        while (Date.now() - start < timeoutMs) {
            const currentLtp = globalLtpMap[instrumentKey];

            if (currentLtp !== undefined) {
                // If the caller requested an instant fill (Initial Entry), return LTP now
                if (paperConfig.isInstantFill || ordertype === "MARKET") {
                    return currentLtp;
                }

                if (ordertype === "LIMIT") {
                    // Re-Cost / Resting Limit logic:
                    if (side === "BUY" && currentLtp <= target) return target;
                    if (side === "SELL" && currentLtp >= target) return target;
                } 
                else if (ordertype === "STOPLOSS_LIMIT" || ordertype === "STOPLOSS") {
                    // Re-Cost Momentum logic:
                    if (side === "BUY" && currentLtp >= target) return target;
                    if (side === "SELL" && currentLtp <= target) return target;
                }
            }

            // Small delay to prevent tight loop if data hasn't arrived yet
            await new Promise(r => setTimeout(r, pollInterval));
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


async function placeStopLossExitOrder({ baseConfig, legSide, entryPrice, instrument, lots, slType, slValue, slLimitMargin, slLimitMarginType = 'POINTS', connectionId }) {
    const prices = computeStopLossExitPrices(
        entryPrice,
        legSide,
        slType,
        slValue,
        slLimitMargin,
        slLimitMarginType
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

/**
 * STOP-LOSS RETRY LOGIC
 * It is extremely important that every trade has a Stop-Loss.
 * If the first attempt to place an SL fails (e.g. network error),
 * this function will try up to 3 times before giving up.
 */
async function placeStopLossWithRetry({ baseConfig, legSide, entryPrice, instrument, lots, slType, slValue, slLimitMargin, slLimitMarginType = 'POINTS', connectionId, strategyId }) {
    let attempts = 3;
    let slOrder = null;
    let lastError = "";

    while (attempts > 0) {
        try {
            slOrder = await placeStopLossExitOrder({
                baseConfig, legSide, entryPrice, instrument, lots, slType, slValue, slLimitMargin, slLimitMarginType, connectionId
            });
            if (slOrder?.orderid) {
                // Success!
                return slOrder;
            }
        } catch (err) {
            lastError = err.message;
            console.error(`[SL Retry] Attempt ${4 - attempts} failed:`, lastError);
        }

        attempts--;
        if (attempts > 0 && (!slOrder || !slOrder.orderid)) {
            await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds before retrying
        }
    }

    // If we reach here, all 3 attempts failed.
    marketSocketService.sendAlert(`CRITICAL: Stop Loss order for ${instrument.symbol} FAILED. Position is UNPROTECTED!`, "error");
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
                console.warn(`[Exit] Cancellation failed for ${leg.orderId}: ${e.message}. It may have filled. Proceeding with LIMIT exit.`);
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
        let finalPrice = "0";
        let exitBaseLtp = null;

        // Always LIMIT — MARKET orders no longer allowed by SEBI
        const ltpRes = await getLtpSecure({
            exchange: instrument.exch_seg,
            symboltoken: instrument.token,
            connectionId: config.connectionId
        });
        if (ltpRes.status && ltpRes.data?.fetched?.[0]) {
            exitBaseLtp = ltpRes.data.fetched[0].ltp;
            const offsetAmt = getLimitOffsetAmt(exitBaseLtp, config);
            if (exitSide === "SELL") finalPrice = roundToTick(exitBaseLtp - offsetAmt).toString();
            else finalPrice = roundToTick(exitBaseLtp + offsetAmt).toString();
        } else if (leg.currentLtp) {
            exitBaseLtp = leg.currentLtp;
            const offsetAmt = getLimitOffsetAmt(exitBaseLtp, config);
            if (exitSide === "SELL") finalPrice = roundToTick(exitBaseLtp - offsetAmt).toString();
            else finalPrice = roundToTick(exitBaseLtp + offsetAmt).toString();
        }

        const closeConfig = {
            ...config,
            side: exitSide,
            variety: "NORMAL",
            ordertype: "LIMIT",
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

        // --- Verified Exit with Chase (Live Only) ---
        // Same 45s chase as entry: modify order every 1s with progressive offset from base LTP.
        // If chase fills, mark leg as exited. If exhausted, throw for caller to handle.
        const strategyId = config.id || "system";
        const fillPrice = await chaseOrderFill({
            orderId: orderData.orderid,
            uniqueOrderId: orderData.uniqueorderid,
            instrument,
            config,
            legSide: exitSide,
            lots: leg.leg.lots,
            connectionId: config.connectionId,
            strategyId,
            baseLtp: exitBaseLtp
        });

        if (fillPrice) {
            leg.exited = true;
            leg.isExiting = false;
            addStrategyLog(strategyId, `Exit confirmed for ${instrument.symbol} at ₹${fillPrice}.`, "INFO");
        } else {
            // Chase exhausted — order already cancelled inside chaseOrderFill
            leg.isExiting = false;
            throw new Error(`EXIT_CHASE_EXHAUSTED: ${instrument.symbol} exit order not filled after 45s price chase. Order cancelled. Position may still be open!`);
        }

        return orderData.orderid;
    } catch (error) {
        if (error.message.startsWith("EXIT_CHASE_EXHAUSTED")) {
            throw error; // Re-throw for caller to handle (PAUSE)
        }
        console.error(`[Exit] Failed to place exit order for ${instrument.symbol}:`, error.message);
        addStrategyLog(config.id || "system", `CRITICAL: Exit placement FAILED for ${instrument.symbol}: ${error.message}. Re-attempting...`, "ERROR");

        leg.isExiting = false;
        return null;
    }
}


module.exports = {
   roundToTick, placeOrder, getLimitOffsetAmt, computeStopLossExitPrices,
   resolveUniversalOrderParams, waitForOrderFillPrice, checkOrderFillOnce,
   chaseOrderFill, placeStopLossExitOrder, placeStopLossWithRetry, placeExitOrder
};
