const { Queue } = require('bullmq');
const IORedis = require('ioredis');
require('dotenv').config();

// BullMQ requires a dedicated Redis connection with maxRetriesPerRequest: null
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

const backtestQueue = new Queue('backtest-jobs', { connection });

/**
 * Adds a new backtest job to the queue
 * @param {Object} data The backtest configuration (strategyId, fromDate, toDate, etc.)
 * @returns {Promise<string>} The job ID
 */
async function addBacktestJob(data) {
    const jobType = data.strategyIds ? 'combined' : 'single';
    
    // Add job to the queue
    // Jobs will be retained for 1 hour so the client can query their result
    const job = await backtestQueue.add(jobType, data, {
        removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
        removeOnFail: { age: 3600 }      // Keep failed jobs for 1 hour
    });
    
    return job.id;
}

module.exports = {
    backtestQueue,
    addBacktestJob,
    connection // export connection if needed for graceful shutdown
};
