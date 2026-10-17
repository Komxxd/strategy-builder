/**
 * Shared Persistent HTTPS Keep-Alive Agent
 * ========================================
 * Prevents expensive TCP handshakes and TLS renegotiation on every broker request.
 * Reuses existing warm sockets to SmartAPI (Angel One), saving 150ms-350ms per request.
 */

const https = require("https");
const axios = require("axios");

const sharedHttpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000,
    keepAliveMsecs: 30000,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3"
});

// Intercept axios.create so all SmartAPI instances automatically inherit Keep-Alive
const originalAxiosCreate = axios.create;
axios.create = function (defaultConfig = {}) {
    defaultConfig.httpsAgent = sharedHttpsAgent;
    return originalAxiosCreate.call(this, defaultConfig);
};

// Also apply to global axios defaults as a fallback
axios.defaults.httpsAgent = sharedHttpsAgent;

console.log("[HTTP Agent] Persistent Keep-Alive Agent initialized (maxSockets: 50, keepAlive: true)");

module.exports = {
    sharedHttpsAgent
};
