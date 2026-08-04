/**
 * STRATEGY SWEEPER
 * ================
 * Runs every 60 seconds. After 11:00 PM IST, automatically transitions all
 * EXITED strategies to COMPLETED and moves them to history, so the active
 * panel is clean at the end of the trading day.
 */

const sql = require("../../config/db");
const { activeStrategies } = require("./strategy.state");
const { withDbRetry } = require("./strategy.crud");

function getISTHourMinute() {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return { hours: ist.getHours(), minutes: ist.getMinutes() };
}

async function sweepExitedStrategies() {
    const { hours, minutes } = getISTHourMinute();
    const isPastMarketClose = hours >= 23;
    if (!isPastMarketClose) return;

    // 1. Sweep from in-memory activeStrategies map
    const exitedIds = [];
    for (const [id, strategy] of activeStrategies) {
        if (strategy.status === "EXITED") {
            exitedIds.push(id);
            strategy.status = "COMPLETED";
            if (strategy.interval) {
                clearInterval(strategy.interval);
                strategy.interval = null;
            }
            activeStrategies.delete(id);
            console.log(`[Sweeper] Strategy ${id} swept from EXITED -> COMPLETED`);
        }
    }

    // 2. Sweep from DB — catches any EXITED rows that may have been persisted
    //    but whose in-memory entry was already gone (e.g., after a server restart)
    try {
        const result = await withDbRetry(() => sql`
            UPDATE strategy_executions
            SET status = 'COMPLETED',
                execution_details = execution_details || '{"moved_to_history": true}'::jsonb,
                completed_at = COALESCE(completed_at, NOW())
            WHERE status = 'EXITED'
              AND (execution_details->>'moved_to_history' IS NULL OR execution_details->>'moved_to_history' != 'true')
        `);
        if (exitedIds.length > 0 || result?.count > 0) {
            console.log(`[Sweeper] DB sweep complete. In-memory: ${exitedIds.length}, DB rows: ${result?.count || 0}`);
        }
    } catch (err) {
        console.error("[Sweeper] DB sweep failed:", err.message);
    }
}

// Run every 60 seconds
setInterval(sweepExitedStrategies, 60 * 1000);

module.exports = { sweepExitedStrategies };
