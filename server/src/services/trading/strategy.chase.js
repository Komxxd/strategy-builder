const { getAuthorizedInstance } = require("../../config/smartapi");
const { addStrategyLog } = require("./strategy.state");
const { roundToTick, getLimitOffsetAmt } = require("./strategy.offset");

/**
 * Single, non-blocking check for order fill status on the broker.
 * Returns { filled, price, rejected, reason } without looping.
 */
async function checkOrderFillOnce(uniqueOrderId, connectionId) {
    try {
        const api = await getAuthorizedInstance(connectionId);
        const details = await api.indOrderDetails(uniqueOrderId);
        if (details?.status && details?.data) {
            const avgPrice = Number(details.data.averageprice || details.data.averagePrice || 0);
            const filledShares = Number(details.data.filledshares || details.data.filledShares || 0);
            const orderStatus = (details.data.orderstatus || details.data.status || "").toString().toLowerCase();

            if ((avgPrice > 0 && filledShares > 0) || orderStatus === "complete" || orderStatus === "filled") {
                return { filled: true, price: avgPrice > 0 ? avgPrice : null, rejected: false, reason: "" };
            }
            if (orderStatus === "rejected" || orderStatus === "cancelled") {
                return { filled: false, price: null, rejected: true, reason: `Order ${orderStatus}: ${details.data.text || details.data.message || ""}` };
            }
        }
    } catch (err) {
        if (err.message?.includes("rejected") || err.message?.includes("cancelled")) {
            return { filled: false, price: null, rejected: true, reason: err.message };
        }
        console.error("[ChaseCheck] Poll error:", err.message);
    }
    return { filled: false, price: null, rejected: false, reason: "" };
}

/**
 * Chase mechanism for LIVE LIMIT orders that handles price slippage.
 *
 * If order doesn't fill within 1 second, it fetchs the LTP ONCE as a base
 * price, then modifies the order every second by progressively adding (BUY)
 * or subtracting (SELL) the limit offset:
 *   Mod #1: baseLTP ± (2 × offset)
 *   Mod #2: baseLTP ± (3 × offset)
 *   ...up to 45 seconds total.
 *
 * @param {number} baseLtp - The LTP at the time the order was placed (used as base for progressive modifications)
 * @returns {number|null} Fill price, or null if not filled after 45s
 */
async function chaseOrderFill({ orderId, uniqueOrderId, instrument, config, legSide, lots, connectionId, strategyId, baseLtp }) {
    const INITIAL_WAIT_MS = 1000;
    const CHASE_INTERVAL_MS = 1000;
    const MAX_CHASE_MS = (parseInt(config.chase_time_seconds) || 45) * 1000;
    
    // Use user offset, but ensure a minimum of 0.05 (1 tick) for the chase to actually move
    const userOffsetAmt = getLimitOffsetAmt(baseLtp, config);
    const offset = Math.max(userOffsetAmt, 0.05); 
    
    const start = Date.now();

    const logChase = (msg, level = "INFO") => {
        // Force log to PM2 console regardless of strategyId presence
        console.log(`[CHASE][${instrument.symbol}] ${msg}`);
        if (strategyId) addStrategyLog(strategyId, `[CHASE] ${msg}`, level);
    };

    logChase(`STARTING CHASE for ${legSide} ${instrument.symbol} (${parseInt(config.chase_time_seconds) || 45}s). Base price: ₹${baseLtp || '?'}. Offset to use: ₹${offset.toFixed(2)} (User Raw: ${config.entry_limit_offset}${config.entry_limit_offset_type === 'PERCENTAGE' ? '%' : 'pts'})`);

    // Phase 1: Wait 1 second for the initial fill (order may fill at the original price)
    await new Promise(r => setTimeout(r, INITIAL_WAIT_MS));

    let check = await checkOrderFillOnce(uniqueOrderId, connectionId);
    if (check.filled) {
        logChase(`${instrument.symbol} filled at ₹${check.price} on first check (no chase needed).`);
        return check.price;
    }
    if (check.rejected) {
        logChase(`${instrument.symbol} rejected before chase started: ${check.reason}`, "ERROR");
        return null;
    }

    if (!baseLtp) {
        logChase(`No base LTP available for ${instrument.symbol}. Waiting without modification.`, "ERROR");
    }

    // Phase 2: Chase loop — modify order every second with progressive offset
    let modifyCount = 0;
    while (Date.now() - start < MAX_CHASE_MS) {
        // 1. Modify the pending order with progressive offset
        if (baseLtp) {
            try {
                modifyCount++;
                // Progressive: baseLTP ± (modifyCount + 1) × offset
                const totalOffsetMultiplier = modifyCount + 1;
                const totalOffsetAmt = offset * totalOffsetMultiplier;
                
                const newPrice = legSide === "BUY"
                    ? roundToTick(baseLtp + totalOffsetAmt)
                    : roundToTick(baseLtp - totalOffsetAmt);

                const api = await getAuthorizedInstance(connectionId);
                await api.modifyOrder({
                    variety: "NORMAL",
                    orderid: orderId,
                    ordertype: "LIMIT",
                    producttype: config.producttype || "CARRYFORWARD",
                    duration: config.duration || "DAY",
                    price: newPrice.toString(),
                    quantity: (lots * parseInt(instrument.lotsize)).toString(),
                    tradingsymbol: instrument.symbol,
                    symboltoken: instrument.token,
                    exchange: instrument.exch_seg,
                });

                logChase(`#${modifyCount} ${legSide} price ↑/↓ to ₹${newPrice} (Base: ₹${baseLtp}, Offset: ${totalOffsetMultiplier}x ${offset.toFixed(2)})`);
            } catch (modErr) {
                const errMsg = modErr.message || "";
                if (errMsg.toLowerCase().includes("completed") || errMsg.toLowerCase().includes("traded")) {
                    const finalCheck = await checkOrderFillOnce(uniqueOrderId, connectionId);
                    if (finalCheck.filled) {
                        logChase(`✅ Filled at ₹${finalCheck.price} (detected during modify).`);
                        return finalCheck.price;
                    }
                }
                if (errMsg.toLowerCase().includes("cancelled") || errMsg.toLowerCase().includes("rejected")) {
                    logChase(`Order ${errMsg}. Stopping.`, "ERROR");
                    return null;
                }
                logChase(`Mod error #${modifyCount}: ${errMsg}`, "ERROR");
            }
        }

        // 2. Wait 1 second
        await new Promise(r => setTimeout(r, CHASE_INTERVAL_MS));

        // 3. Check fill
        check = await checkOrderFillOnce(uniqueOrderId, connectionId);
        if (check.filled) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            logChase(`✅ SUCCESS: ${instrument.symbol} filled at ₹${check.price} after ${elapsed}s chase (${modifyCount} mods).`);
            return check.price;
        }
        if (check.rejected) {
            logChase(`Order rejected during chase: ${check.reason}`, "ERROR");
            return null;
        }
    }

    // Cancel the unfilled order
    try {
        const api = await getAuthorizedInstance(connectionId);
        await api.cancelOrder({ variety: "NORMAL", orderid: orderId });
        logChase(`EXHAUSTED: Cancelled unfilled order ${orderId} after 45s.`, "CRITICAL");
    } catch (cancelErr) {
        const lastCheck = await checkOrderFillOnce(uniqueOrderId, connectionId);
        if (lastCheck.filled) return lastCheck.price;
    }

    return null;
}

module.exports = {
    checkOrderFillOnce,
    chaseOrderFill
};
