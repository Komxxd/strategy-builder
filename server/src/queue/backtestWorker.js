const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const BacktestEngine = require('../services/backtest/backtest.engine');
require('dotenv').config();

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

const worker = new Worker('backtest-jobs', async (job) => {
    const sanitizeBigInt = (obj) => {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'bigint') return Number(obj);
        if (Array.isArray(obj)) return obj.map(sanitizeBigInt);
        if (typeof obj === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = sanitizeBigInt(value);
            }
            return result;
        }
        return obj;
    };
    try {
        console.log(`[Worker] Started job ${job.id} of type ${job.name}`);
        const startCpu = process.cpuUsage();
        const startMem = process.memoryUsage();

        if (job.name === 'single') {
            const { strategyId, fromDate, toDate } = job.data;
            const engine = new BacktestEngine(strategyId, fromDate, toDate);
            const results = await engine.run();
            
            const endCpu = process.cpuUsage(startCpu);
            const endMem = process.memoryUsage();
            console.log(`[Worker] Single Backtest CPU: User ${Math.round(endCpu.user / 1000)}ms, System ${Math.round(endCpu.system / 1000)}ms`);
            
            return sanitizeBigInt(results); // BullMQ stores this returned value in job.returnvalue
        } else if (job.name === 'combined') {
            const { strategyIds, fromDate, toDate } = job.data;
            
            const allResults = [];
            for (const strategyId of strategyIds) {
                const engine = new BacktestEngine(strategyId, fromDate, toDate);
                const results = await engine.run();
                results.strategyId = strategyId;
                if (results.trades) {
                    results.trades.forEach(t => t.strategyId = strategyId);
                }
                allResults.push(results);
            }

            // Combine all results
            const combined = {
                totalPnL: 0,
                trades: [],
                dailySummary: {},
                chartData: {}
            };

            allResults.forEach(res => {
                combined.totalPnL += res.totalPnL || 0;
                if (res.trades) {
                    const taggedTrades = res.trades.map(t => ({
                        ...t,
                        leg_id: `${res.strategyId || 'strat'}_${t.leg_id}`
                    }));
                    combined.trades.push(...taggedTrades);
                }

                if (res.dailySummary) {
                    for (const [date, summary] of Object.entries(res.dailySummary)) {
                        if (!combined.dailySummary[date]) {
                            combined.dailySummary[date] = { pnl: 0, trade_value: 0, pnl_percent: 0, dtes: new Set(), expiries: new Set(), strategies: {} };
                        }
                        combined.dailySummary[date].pnl += summary.pnl || 0;
                        combined.dailySummary[date].trade_value += summary.trade_value || 0;
                        if (summary.dte !== undefined) combined.dailySummary[date].dtes.add(summary.dte);
                        if (summary.expiry) combined.dailySummary[date].expiries.add(summary.expiry);
                        combined.dailySummary[date].strategies[res.strategyId] = summary;
                    }
                }

                if (res.chartData) {
                    for (const [date, dayChart] of Object.entries(res.chartData)) {
                        if (!combined.chartData[date]) {
                            combined.chartData[date] = {};
                        }
                        for (const [key, data] of Object.entries(dayChart)) {
                            if (key === 'OVERALL_PNL') {
                                if (!combined.chartData[date]['OVERALL_PNL']) {
                                    combined.chartData[date]['OVERALL_PNL'] = data.map(d => ({ ...d }));
                                } else {
                                    const existing = combined.chartData[date]['OVERALL_PNL'];
                                    data.forEach(d => {
                                        const match = existing.find(e => e.time === d.time);
                                        if (match) {
                                            match.pnl += d.pnl;
                                        } else {
                                            existing.push({ ...d });
                                        }
                                    });
                                    existing.sort((a, b) => a.time.localeCompare(b.time));
                                }
                            } else {
                                combined.chartData[date][`${res.strategyId || 'strat'}_${key}`] = data;
                            }
                        }
                    }
                }
            });

            // Finalize dailySummary arrays and pnl_percent
            for (const [date, summary] of Object.entries(combined.dailySummary)) {
                summary.pnl_percent = summary.trade_value > 0 ? (summary.pnl / summary.trade_value) * 100 : 0;
                summary.dte = Array.from(summary.dtes)[0];
                summary.expiry = Array.from(summary.expiries)[0];
                delete summary.dtes;
                delete summary.expiries;
            }

            combined.trades.sort((a, b) => (a.exitTime || '').localeCompare(b.exitTime || ''));
            
            const endCpu = process.cpuUsage(startCpu);
            console.log(`[Worker] Combined Backtest CPU: User ${Math.round(endCpu.user / 1000)}ms, System ${Math.round(endCpu.system / 1000)}ms`);
            
            return sanitizeBigInt(combined);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    } catch (error) {
        console.error(`[Worker] Job ${job.id} failed:`, error);
        throw error;
    }
}, { 
    connection,
    // Concurrency: How many backtests to run in parallel on this droplet.
    // Given memory limits and cpu usage, maybe limit to 2 or 4. Let's use 2.
    concurrency: 2 
});

worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed successfully.`);
});

worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job.id} failed with error:`, err);
});

module.exports = worker;
