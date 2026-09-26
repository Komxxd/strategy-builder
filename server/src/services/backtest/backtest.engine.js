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
        this.strategy = strategies[0];
    }

    async run() {
        if (!this.strategy) await this.init();

        const MAX_RETRIES = 3;
        const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

                const response = await fetch('http://localhost:8000/backtest', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        strategy: this.strategy,
                        fromDate: this.fromDate,
                        toDate: this.toDate
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Python Backtest API Error: ${response.status} ${response.statusText}`, errorText);
                    throw new Error(`Python Engine API failed: ${errorText}`);
                }

                const results = await response.json();
                return results;
            } catch (error) {
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
            }
        }
    }
}

module.exports = BacktestEngine;
