const prisma = require("../../config/prisma");
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
 * Lean core engine loop.
 * Orchestrates the transition from WAITING -> IN_POSITION -> COMPLETED.
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

            // Phase 1: WAITING -> Start Entry
            if (status === "WAITING" && currentTime >= strategy.config.entry_time) {
                await handleInitialEntry(strategyId, strategy);
            }

            // Phase 2: IN_POSITION -> Monitor and Manage
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
 * Starts a new execution instance for a strategy template.
 */
async function startStrategy(strategyId, overrideIsPaperTrading) {
    const template = await withDbRetry(() => prisma.strategies.findUnique({ where: { id: strategyId } }));
    if (!template) throw new Error("Strategy template not found");

    const execution = await withDbRetry(() => prisma.strategy_executions.create({
        data: { strategy_id: template.id, status: 'WAITING', execution_details: {} }
    }));

    const runtimeStrategy = {
        id: execution.id,
        config: {
            ...template.config,
            is_paper_trading: overrideIsPaperTrading !== undefined ? overrideIsPaperTrading : (template.config.is_paper_trading || false)
        },
        status: "WAITING",
        entryAttempted: false,
        startTime: new Date(),
        legs: []
    };

    activeStrategies.set(execution.id, runtimeStrategy);
    updateStrategyInMemory(execution.id, { config: runtimeStrategy.config });
    executeStrategy(execution.id);
    return execution.id;
}

/**
 * Manually closes all open positions in a strategy.
 */
async function stopStrategy(strategyId) {
    const { activeStrategies } = require("./strategy.state");
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;
    if (strategy.interval) clearInterval(strategy.interval);
    activeStrategies.delete(strategyId);
    await prisma.strategy_executions.update({ where: { id: strategyId }, data: { status: "STOPPED", completed_at: new Date() } });
}

async function deleteStrategyExecution(executionId) {
    const { activeStrategies } = require("./strategy.state");
    const strategy = activeStrategies.get(executionId);
    if (strategy && strategy.interval) clearInterval(strategy.interval);
    activeStrategies.delete(executionId);
    await prisma.strategy_executions.delete({ where: { id: executionId } });
    return { success: true };
}

async function initializeActiveStrategies() {
    try {
        const activeExecutions = await withDbRetry(() =>
            prisma.strategy_executions.findMany({
                where: { status: { in: ["WAITING", "IN_POSITION"] } },
                include: { strategy: true }
            })
        );

        for (const exec of activeExecutions) {
            if (!exec.strategy) continue;

            const runtimeStrategy = {
                id: exec.id,
                config: exec.execution_details?.config || exec.strategy.config,
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
            console.log(`[Auto-Resume] Restored strategy ${exec.id} (${exec.strategy.name}) in ${exec.status} state.`);
        }
    } catch (err) {
        console.error("Failed to initialize active strategies:", err.message);
    }
}

module.exports = {
   executeStrategy, startStrategy, squareOffStrategy, stopStrategy, deleteStrategyExecution, squareOffLeg, resumeStrategy, initializeActiveStrategies
};
