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

/**
 * Cancels a backtest job if waiting, or dispatches a cancellation signal if active
 * @param {string} jobId The job ID to cancel
 */
async function cancelBacktestJob(jobId) {
    if (!jobId) return { success: false, message: "Job ID is required" };

    try {
        // Set cancelled flag in Redis for workers to check
        await connection.set(`backtest:cancelled:${jobId}`, '1', 'EX', 3600);
        // Publish cancellation event to alert workers in real-time
        await connection.publish('backtest:cancel', jobId);

        const job = await backtestQueue.getJob(jobId);
        if (!job) {
            return { success: true, message: "Cancellation signal published (job not found or already finished)" };
        }

        const state = await job.getState();
        if (state === 'waiting' || state === 'delayed') {
            await job.remove();
            return { success: true, message: "Queued job removed from queue", state };
        }

        if (state === 'active') {
            try {
                await job.discard();
            } catch (e) {}
            return { success: true, message: "Cancellation signal sent to running job", state };
        }

        return { success: true, message: `Job is currently in ${state} state`, state };
    } catch (error) {
        console.error(`[BacktestQueue] Error cancelling job ${jobId}:`, error);
        throw error;
    }
}

module.exports = {
    backtestQueue,
    addBacktestJob,
    cancelBacktestJob,
    connection // export connection if needed for graceful shutdown
};
