const { activeStrategies, globalLtpMap, updateLtp, getLtpSecure, runGlobalDbWriter, updateStrategyInMemory, runGlobalWebsocketSync, addStrategyLog, getStatus } = require("./trading/strategy.state");
const { withDbRetry, saveStrategy, updateStrategy, deleteStrategy, getUserStrategies, getActiveStrategies, getExecutionHistory, patchExecutionSettings } = require("./trading/strategy.crud");
const { executeStrategy, startStrategy, stopStrategy, deleteStrategyExecution, initializeActiveStrategies } = require("./trading/strategy.engine");
const { squareOffStrategy, squareOffLeg, resumeStrategy } = require("./trading/strategy.lifecycle");

/**
 * Legacy Compatibility Layer
 * All logic has been modularized into the ./trading folder.
 * This file remains as an orchestrator/exporter for the rest of the app.
 */
module.exports = {
    // State & Monitoring
    activeStrategies,
    globalLtpMap,
    updateLtp,
    getLtpSecure,
    updateStrategyInMemory,
    addStrategyLog,
    getStatus,
    runGlobalWebsocketSync,
    flushPendingDbWrites: runGlobalDbWriter,

    // Database CRUD
    withDbRetry,
    saveStrategy,
    updateStrategy,
    deleteStrategy,
    getUserStrategies,
    getActiveStrategies,
    getExecutionHistory,
    patchExecutionSettings,

    // Engine Operations
    executeStrategy,
    startStrategy,
    stopStrategy,
    deleteStrategyExecution,
    initializeActiveStrategies,

    // Lifecycle Transitions
    squareOffStrategy,
    squareOffLeg,
    resumeStrategy
};
