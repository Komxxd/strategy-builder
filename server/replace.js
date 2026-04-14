const fs = require('fs');

const file = '/Users/komalkumari/Developer/strategy-builder/server/src/services/trading/strategy.engine.js';
let lines = fs.readFileSync(file, 'utf8').split('\n');

// Find the import line and add checkOverallPnlLimits
const importIndex = lines.findIndex(l => l.includes('const { getISTTime, getISTFullDate } = require("./strategy.time");'));
if (importIndex !== -1) {
    lines.splice(importIndex + 1, 0, 'const { checkOverallPnlLimits } = require("./strategy.pnl");');
}

// Find lines 1158 (Check Overall Stop Loss) to 1308
const startIdx = lines.findIndex(l => l.includes('// Check Overall Stop Loss'));
const endIdx = lines.findIndex(l => l.includes('// Manual Check for TSL and Static SL'));

if (startIdx !== -1 && endIdx !== -1) {
    const replacement = `                        // Check Overall Stop Loss and Target
                        const limitCheck = checkOverallPnlLimits({ config, totalPnlRupees, avgPnl });

                        if (limitCheck.hit) {
                            if (strategy.exitAttempted) return;
                            strategy.exitAttempted = true;
                            console.log(\`[\${new Date().toISOString()}] \${limitCheck.reason} for strategy \${strategyId}. Exiting remaining legs.\`);

                            // Cancel any pending SL orders on exchange for active legs
                            if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
                                await Promise.all(strategy.legs.map(async (leg) => {
                                    if (!leg.exited && leg.slOrderId) {
                                        try {
                                            const api = await getAuthorizedInstance(config.connectionId);
                                            await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                                            console.log(\`Cancelled SL order \${leg.slOrderId} for \${leg.instrument?.symbol || 'Unknown'} due to \${limitCheck.exitType}\`);
                                        } catch (e) {
                                            console.error(\`Failed to cancel SL order \${leg.slOrderId}:\`, e.message);
                                        }
                                    }
                                }));
                            }

                            try {
                                const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
                                    if (leg.exited) return leg.exitOrderId;
                                    return await placeExitOrder({
                                        config,
                                        leg,
                                        instrument: leg.instrument,
                                        exitType: limitCheck.exitType
                                    });
                                }));
                                strategy.status = "COMPLETED";
                                strategy.exitOrderId = exitOrders;
                                strategy.exitType = limitCheck.exitType;
                                addStrategyLog(strategyId, \`\${limitCheck.logMessage} Final PnL: ₹\${totalPnlRupees.toFixed(2)} (\${avgPnl.toFixed(2)}%).\`, limitCheck.logLevel);
                                updateStrategyInMemory(strategyId, {
                                    status: "COMPLETED",
                                    exit_order_id: strategy.exitOrderId,
                                    exit_type: limitCheck.exitType,
                                    final_pnl_percent: avgPnl,
                                    totalPnlRupees: totalPnlRupees,
                                    totalOriginalValue: strategy.totalOriginalValue,
                                    legs: strategy.legs
                                });
                                clearInterval(interval);
                                return;
                            } catch (exitErr) {
                                if (exitErr.message?.startsWith("EXIT_CHASE_EXHAUSTED")) {
                                    strategy.status = "PAUSED";
                                    strategy.error = exitErr.message;
                                    addStrategyLog(strategyId, \`Strategy PAUSED during \${limitCheck.exitType} exit: \${exitErr.message}. Manual action required.\`, "CRITICAL");
                                    marketSocketService.sendAlert(\`Strategy PAUSED — exit chase failed during \${limitCheck.exitType}\`, "error");
                                    updateStrategyInMemory(strategyId, { status: "PAUSED", error: exitErr.message });
                                    clearInterval(interval);
                                    return;
                                }
                                throw exitErr;
                            }
                        }
`;
    lines.splice(startIdx, endIdx - startIdx, replacement);
    fs.writeFileSync(file, lines.join('\n'));
    console.log("Successfully replaced PnL check block in engine.");
} else {
    console.log("Could not find start/end markers.");
}
