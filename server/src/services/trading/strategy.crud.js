const prisma = require("../../config/prisma");
const { getStatus } = require("./strategy.state");

/**
 * Retries an async DB operation up to `maxRetries` times with exponential backoff.
 * This prevents a sleeping Neon database from crashing a strategy on startup.
 * @param {Function} fn - Async function to retry (e.g., () => prisma.xxx.findUnique(...))
 * @param {number} maxRetries - Max number of attempts (default: 3)
 * @param {number} baseDelayMs - Initial delay in ms, doubles each attempt (default: 1000ms)
 * @returns {Promise<any>} - Result of the successful call
 */
async function withDbRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isRetryable =
                err.message.includes("Can't reach database") ||
                err.message.includes("connection pool") ||
                err.message.includes("ECONNREFUSED") ||
                err.message.includes("Connection timed out");

            if (!isRetryable || attempt === maxRetries) {
                throw err; // Non-retryable error or out of attempts
            }

            const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
            console.warn(`[DbRetry] Attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms... Error: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

async function saveStrategy(config) {
    if (config.name) {
        const existing = await prisma.strategies.findFirst({
            where: {
                name: {
                    equals: config.name.trim(),
                    mode: 'insensitive'
                }
            }
        });
        if (existing) {
            throw new Error(`A strategy named "${config.name}" already exists.`);
        }
    }

    const cleanConfig = { ...config };
    delete cleanConfig.is_paper_trading;

    const data = await prisma.strategies.create({
        data: {
            name: config.name || `Strategy ${new Date().toLocaleTimeString()}`,
            config: cleanConfig
        }
    });
    return data;
}

async function updateStrategy(strategyId, config) {
    if (config.name) {
        const existing = await prisma.strategies.findFirst({
            where: {
                name: {
                    equals: config.name.trim(),
                    mode: 'insensitive'
                },
                id: { not: strategyId }
            }
        });
        if (existing) {
            throw new Error(`A strategy named "${config.name}" already exists.`);
        }
    }

    const cleanConfig = { ...config };
    delete cleanConfig.is_paper_trading;

    const data = await prisma.strategies.update({
        where: { id: strategyId },
        data: {
            name: config.name || `Strategy ${new Date().toLocaleTimeString()}`,
            config: cleanConfig
        }
    });

    return data;
}

async function deleteStrategy(strategyId) {
    await prisma.strategies.delete({
        where: { id: strategyId }
    });
    return true;
}

async function getUserStrategies() {
    const data = await withDbRetry(() =>
        prisma.strategies.findMany({ orderBy: { created_at: 'desc' } })
    );
    return data;
}

async function getActiveStrategies() {
    const executions = await withDbRetry(() =>
        prisma.strategy_executions.findMany({
            where: { status: { in: ['WAITING', 'IN_POSITION', 'PAUSED'] } },
            orderBy: { started_at: 'desc' },
            include: { strategy: { select: { name: true } } }
        })
    );

    return Promise.all(executions.map(exec => getStatus(exec.id)));
}

async function getExecutionHistory() {
    const executions = await withDbRetry(() =>
        prisma.strategy_executions.findMany({
            where: {
                status: {
                    in: ["COMPLETED", "FAILED", "TERMINATED", "CANCELLED", "STOPPED", "SQUARED_OFF"]
                }
            },
            orderBy: {
                completed_at: { sort: "desc", nulls: "last" }
            },
            include: {
                strategy: {
                    select: {
                        name: true,
                        config: true
                    }
                }
            },
            take: 50
        })
    );

    return executions.map(dbExec => ({
        id: dbExec.id,
        status: dbExec.status,
        config: dbExec.execution_details?.config || dbExec.strategy?.config || {},
        name: dbExec.strategy?.name || (dbExec.execution_details?.config?.name) || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        logs: dbExec.execution_details?.logs || [],
        legs: dbExec.execution_details?.legs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalPnlRupees: dbExec.total_pnl_rupees || 0,
        totalOriginalValue: dbExec.execution_details?.totalOriginalValue || 0,
        exitType: dbExec.exit_type,
        started_at: dbExec.started_at,
        completed_at: dbExec.completed_at || dbExec.updatedAt
    }));
}

module.exports = {
   withDbRetry,
   saveStrategy,
   updateStrategy,
   deleteStrategy,
   getUserStrategies,
   getActiveStrategies,
   getExecutionHistory
};
