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

        try {
            const response = await fetch('http://localhost:8000/backtest', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    strategy: this.strategy,
                    fromDate: this.fromDate,
                    toDate: this.toDate
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Python Backtest API Error: ${response.status} ${response.statusText}`, errorText);
                throw new Error(`Python Engine API failed: ${errorText}`);
            }

            const results = await response.json();
            return results;
        } catch (error) {
            console.error('Failed to communicate with Python backtest server:', error);
            throw error;
        }
    }
}

module.exports = BacktestEngine;
