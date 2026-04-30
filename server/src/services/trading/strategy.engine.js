/**
 * STRATEGY ENGINE SERVICE
 * =======================
 * This is the "Brain" or "Orchestrator" of the trading system.
 */

const sql = require("../../config/db");
const { getAuthorizedInstance } = require("../../config/smartapi");
const marketSocketService = require("../marketSocket.service");
const { activeStrategies, getLtpSecure, updateStrategyInMemory, addStrategyLog } = require("./strategy.state");
const { withDbRetry } = require("./strategy.crud");
const { getISTTime } = require("./strategy.time");
const { handleInitialEntry } = require("./strategy.init");
const { monitorStrategyLoop } = require("./strategy.monitor");
const { handleLegStopOut, pauseStrategy, squareOffStrategy, squareOffLeg, resumeStrategy } = require("./strategy.lifecycle");
const { placeExitOrder } = require("./strategy.execution");

/**
 * The CORE LOOP function.
 */
async function executeStrategy(strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy || strategy.interval) return;

    addStrategyLog(strategyId, `Strategy Execution started. Waiting for Entry Time ${strategy.config.entry_time}...`, "INFO");

    const interval = setInterval(async () => {
        if (strategy.isProcessing) return;
        strategy.isProcessing = true;

        try {
            const status = strategy.status;
            const currentTime = getISTTime();

            if (status === "WAITING" && currentTime >= strategy.config.entry_time) {
                await handleInitialEntry(strategyId, strategy);
            }

            if (status === "IN_POSITION") {
                const result = await monitorStrategyLoop(strategyId, strategy);
                if (result === "TERMINATE") {
                    clearInterval(interval);
                    return;
                }
            }
        } catch (err) {
            console.error(`[Engine][${strategyId}] Loop error:`, err.message);
        } finally {
            strategy.isProcessing = false;
        }
    }, 1000);

    strategy.interval = interval; 
}

/**
 * STARTS a strategy.
 */
async function startStrategy(strategyId, overrideIsPaperTrading) {
    const [template] = await withDbRetry(() => sql`SELECT * FROM strategies WHERE id = ${strategyId} LIMIT 1`);
    if (!template) throw new Error("Strategy template not found");

    const runtimeConfig = {
        ...template.config,
        is_paper_trading: overrideIsPaperTrading !== undefined ? overrideIsPaperTrading : (template.config.is_paper_trading || false)
    };

    const [execution] = await withDbRetry(() => sql`
        INSERT INTO strategy_executions (strategy_id, status, execution_details)
        VALUES (${template.id}, 'WAITING', ${sql.json({ config: runtimeConfig })})
        RETURNING *
    `);

    const runtimeStrategy = {
        id: execution.id,
        config: runtimeConfig,
        status: "WAITING",
        entryAttempted: false,
        startTime: new Date(),
        legs: []
    };

    activeStrategies.set(execution.id, runtimeStrategy);
    executeStrategy(execution.id);
    return execution.id;
}

async function stopStrategy(strategyId) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;
    if (strategy.interval) clearInterval(strategy.interval);
    strategy.status = "STOPPED";
    updateStrategyInMemory(strategyId, { 
        status: "STOPPED",
        final_pnl_percent: strategy.pnlPercent || 0,
        totalPnlRupees: strategy.totalPnlRupees || 0,
        legs: strategy.legs
    });
    activeStrategies.delete(strategyId);
}

async function deleteStrategyExecution(executionId) {
    const strategy = activeStrategies.get(executionId);
    if (strategy && strategy.interval) clearInterval(strategy.interval);
    activeStrategies.delete(executionId);
    await sql`DELETE FROM strategy_executions WHERE id = ${executionId}`;
    return { success: true };
}

async function initializeActiveStrategies() {
    try {
        const activeExecutions = await withDbRetry(() =>
            sql`
                SELECT e.*, s.name as strategy_name, s.config as strategy_template_config
                FROM strategy_executions e
                JOIN strategies s ON e.strategy_id = s.id
                WHERE e.status IN ('WAITING', 'IN_POSITION')
            `
        );

        for (const exec of activeExecutions) {
            const runtimeStrategy = {
                id: exec.id,
                config: exec.execution_details?.config || exec.strategy_template_config,
                status: exec.status,
                startTime: exec.started_at,
                legs: exec.execution_details?.legs || [],
                logs: exec.execution_details?.logs || [],
                entryAttempted: exec.execution_details?.entryAttempted || false,
                exitAttempted: exec.execution_details?.exitAttempted || false,
                totalPnlRupees: exec.execution_details?.totalPnlRupees || 0,
                pnlPercent: exec.execution_details?.pnlPercent || 0,
                totalOriginalValue: exec.execution_details?.totalOriginalValue || 0
            };

            activeStrategies.set(exec.id, runtimeStrategy);
            executeStrategy(exec.id);
            console.log(`[Auto-Resume] Restored strategy ${exec.id} (${exec.strategy_name}) in ${exec.status} state.`);
        }
    } catch (err) {
        console.error("Failed to initialize active strategies:", err.message);
    }
}

module.exports = {
   executeStrategy, startStrategy, squareOffStrategy, stopStrategy, deleteStrategyExecution, squareOffLeg, resumeStrategy, initializeActiveStrategies
};
