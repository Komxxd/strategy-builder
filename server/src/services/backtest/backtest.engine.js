const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getStrategyById } = require('../trading/strategy.crud');

class BacktestEngine {
    constructor(strategyId, fromDate, toDate, userId) {
        this.strategyId = strategyId;
        this.fromDate = fromDate;
        this.toDate = toDate;
        this.userId = userId;
        this.strategy = null;
    }

    async init() {
        const strategies = await getStrategyById(this.strategyId, this.userId);
        if (!strategies || strategies.length === 0) {
            throw new Error(`Strategy not found for id ${this.strategyId}`);
        }
        // Deep clone so DB/in-memory strategies are not mutated
        const strat = JSON.parse(JSON.stringify(strategies[0]));
        if (strat && strat.config) {
            // For backtest, default quantity to 1 regardless of outside settings
            strat.config.quantity_multiplier = 1;
            if (Array.isArray(strat.config.legs) && strat.config.legs.length > 0) {
                const validLots = strat.config.legs
                    .map(l => parseInt(l.lots) || 1)
                    .filter(lots => lots > 0);
                const minLots = validLots.length > 0 ? Math.min(...validLots) : 1;
                strat.config.legs.forEach(l => {
                    const currentLots = parseInt(l.lots) || 1;
                    l.lots = minLots > 0 ? Math.max(1, Math.round(currentLots / minLots)) : 1;
                });
            }
        }
        this.strategy = strat;
    }

    async run(signal, jobId) {
        if (!this.strategy) await this.init();

        const MAX_RETRIES = 3;
        const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            if (signal?.aborted) {
                throw new Error('Backtest cancelled by user');
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const onAbort = () => {
                controller.abort();
                if (jobId) {
                    fetch(`http://localhost:8000/cancel/${jobId}`, { method: 'POST' }).catch(() => {});
                }
            };

            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }

            try {
                const response = await fetch('http://localhost:8000/backtest', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        strategy: this.strategy,
                        fromDate: this.fromDate,
                        toDate: this.toDate,
                        jobId: jobId || undefined
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Python Backtest API Error: ${response.status} ${response.statusText}`, errorText);
                    throw new Error(`Python Engine API failed: ${errorText}`);
                }

                const results = await response.json();
                return results;
            } catch (error) {
                if (signal?.aborted) {
                    throw new Error('Backtest cancelled by user');
                }

                const isRetryable = error.cause?.code === 'UND_ERR_SOCKET' 
                    || error.cause?.code === 'ECONNREFUSED'
                    || error.cause?.code === 'ECONNRESET'
                    || error.name === 'AbortError';

                if (isRetryable && attempt < MAX_RETRIES) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    console.warn(`[BacktestEngine] Attempt ${attempt}/${MAX_RETRIES} failed (${error.cause?.code || error.name}), retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                console.error('Failed to communicate with Python backtest server:', error);
                throw error;
            } finally {
                clearTimeout(timeout);
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
            }
        }
    }
}

module.exports = BacktestEngine;
