require("dotenv").config();

console.log("Starting Backtest Server...");

// Import DB so it connects (if backtest engine relies on global pool/ORM)
require('./config/db');

// Import the worker to start listening to the queue
const worker = require('./queue/backtestWorker');

console.log("Backtest Worker started and listening for jobs on Redis:", process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Sync market dates into Redis so the Main Server API knows what's available
const syncMarketDates = require('./utils/syncMarketDates');
syncMarketDates();

// Optional: Set up a CRON job to download data daily after market hours (e.g. 16:00 IST)
// const cron = require('node-cron');
// cron.schedule('0 16 * * 1-5', async () => {
//     console.log("Running daily data fetch...");
//     // Implementation for data download goes here
// });

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down worker...');
    await worker.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down worker...');
    await worker.close();
    process.exit(0);
});
