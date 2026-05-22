const sql = require("../../config/db");
const { getStatus } = require("./strategy.state");

/**
 * Retries an async DB operation up to `maxRetries` times with exponential backoff.
 * @param {Function} fn - Async function to retry
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
            // Supavisor/Supabase specific retryable errors
            const isRetryable =
                err.message.includes("connection") ||
                err.message.includes("terminated") ||
                err.message.includes("closed") ||
                err.message.includes("timeout") ||
                err.message.includes("reset");

            if (!isRetryable || attempt === maxRetries) {
                throw err;
            }

            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.warn(`[DbRetry] Attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms... Error: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

async function saveStrategy(config) {
    if (config.name) {
        const existing = await sql`
            SELECT id FROM strategies 
            WHERE LOWER(TRIM(name)) = LOWER(TRIM(${config.name}))
            LIMIT 1
        `;
        if (existing.length > 0) {
            throw new Error(`A strategy named "${config.name}" already exists.`);
        }
    }

    const cleanConfig = { ...config };
    delete cleanConfig.is_paper_trading;

    const name = config.name || `Strategy ${new Date().toLocaleTimeString()}`;

    const [data] = await sql`
        INSERT INTO strategies (name, config, status)
        VALUES (${name}, ${sql.json(cleanConfig)}, 'INACTIVE')
        RETURNING *
    `;
    return data;
}

async function updateStrategy(strategyId, config) {
    if (config.name) {
        const existing = await sql`
            SELECT id FROM strategies 
            WHERE LOWER(TRIM(name)) = LOWER(TRIM(${config.name}))
            AND id != ${strategyId}
            LIMIT 1
        `;
        if (existing.length > 0) {
            throw new Error(`A strategy named "${config.name}" already exists.`);
        }
    }

    const cleanConfig = { ...config };
    delete cleanConfig.is_paper_trading;

    const name = config.name || `Strategy ${new Date().toLocaleTimeString()}`;

    const [data] = await sql`
        UPDATE strategies 
        SET name = ${name}, config = ${sql.json(cleanConfig)}, updated_at = NOW()
        WHERE id = ${strategyId}
        RETURNING *
    `;

    return data;
}

async function deleteStrategy(strategyId) {
    await sql`DELETE FROM strategies WHERE id = ${strategyId}`;
    return true;
}

async function getUserStrategies() {
    const data = await withDbRetry(() =>
        sql`SELECT * FROM strategies ORDER BY created_at DESC`
    );
    return data;
}

async function getActiveStrategies() {
    const executions = await withDbRetry(() =>
        sql`
            SELECT e.*, s.name as strategy_name
            FROM strategy_executions e
            LEFT JOIN strategies s ON e.strategy_id = s.id
            WHERE e.status IN ('WAITING', 'IN_POSITION', 'PAUSED')
            ORDER BY e.started_at DESC
        `
    );

    // Map back to expected structure
    const results = executions.map(e => ({
        ...e,
        strategy: { name: e.strategy_name }
    }));

    return Promise.all(results.map(exec => getStatus(exec.id)));
}

async function getExecutionHistory() {
    const executions = await withDbRetry(() =>
        sql`
            SELECT e.*, s.name as strategy_name, s.config as strategy_config
            FROM strategy_executions e
            LEFT JOIN strategies s ON e.strategy_id = s.id
            WHERE e.status IN ('COMPLETED', 'FAILED', 'TERMINATED', 'CANCELLED', 'STOPPED', 'SQUARED_OFF')
            ORDER BY COALESCE(e.completed_at, e.started_at) DESC
            LIMIT 50
        `
    );

    return executions.map(dbExec => ({
        id: dbExec.id,
        status: dbExec.status,
        config: dbExec.execution_details?.config || dbExec.strategy_config || {},
        name: dbExec.strategy_name || (dbExec.execution_details?.config?.name) || "Deployed Strategy",
        error: dbExec.execution_details?.error,
        logs: dbExec.execution_details?.logs || [],
        legs: dbExec.execution_details?.legs || [],
        pnlPercent: dbExec.final_pnl_percent || 0,
        totalPnlRupees: dbExec.total_pnl_rupees || 0,
        totalOriginalValue: dbExec.execution_details?.totalOriginalValue || 0,
        exitType: dbExec.exit_type,
        started_at: dbExec.started_at,
        completed_at: dbExec.completed_at
    }));
}

/**
 * Safely patches only execution settings (e.g. quantity_multiplier) on a strategy.
 * Reads the existing config from DB first, merges the settings, writes back.
 * This prevents accidental overwrites of the full config.
 */
async function patchExecutionSettings(strategyId, settings) {
    const [existing] = await withDbRetry(() =>
        sql`SELECT * FROM strategies WHERE id = ${strategyId} LIMIT 1`
    );
    if (!existing) throw new Error("Strategy not found");

    const mergedConfig = {
        ...existing.config,
        ...settings
    };

    const [data] = await withDbRetry(() => sql`
        UPDATE strategies
        SET config = ${sql.json(mergedConfig)}, updated_at = NOW()
        WHERE id = ${strategyId}
        RETURNING *
    `);
    return data;
}

module.exports = {
   withDbRetry,
   saveStrategy,
   updateStrategy,
   deleteStrategy,
   getUserStrategies,
   getActiveStrategies,
   getExecutionHistory,
   patchExecutionSettings
};
