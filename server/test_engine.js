require('dotenv').config();
const postgres = require('postgres');
const BacktestEngine = require('./src/services/backtest/backtest.engine');

const sql = postgres(process.env.DATABASE_URL);

async function runTest() {
    try {
        const strategies = await sql`SELECT id, user_id FROM strategies LIMIT 1`;
        if (strategies.length === 0) {
            console.log("No strategies found in DB.");
            process.exit(0);
        }
        const strategyId = strategies[0].id;
        const userId = strategies[0].user_id;

        console.log(`Running backtest for Strategy ID: ${strategyId} (User: ${userId})`);
        
        // Run backtest for 1 month to test
        const engine = new BacktestEngine(strategyId, '2026-05-01', '2026-05-31', userId);
        const results = await engine.run();
        
        console.log("Backtest completed successfully!");
        console.log("Total PnL:", results.totalPnL);
        console.log("Trades Count:", results.trades.length);
        
        process.exit(0);
    } catch (e) {
        console.error("Test failed:", e);
        process.exit(1);
    }
}

runTest();
