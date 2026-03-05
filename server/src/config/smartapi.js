const smartapi = require("smartapi-javascript");
const sessionService = require("../services/session.service");

// Singleton cache to reuse API instances per connection/user
const instanceCache = new Map();

/**
 * Gets a SmartAPI instance authorized for the given connection ID
 * @param {string} connectionId 
 * @returns {Promise<SmartAPI>}
 */
async function getAuthorizedInstance(connectionId) {
  if (!connectionId) {
    return defaultSmartApi;
  }

  const session = sessionService.getSession(connectionId);
  if (!session || !session.jwtToken) {
    return defaultSmartApi; // Fallback to global if active session for user not found
  }

  let smartApi = instanceCache.get(connectionId);

  if (!smartApi) {
    console.log(`[SmartAPI Config] Creating new singleton instance for connection: ${connectionId}`);
    smartApi = new smartapi.SmartAPI({
      api_key: session.api_key || process.env.SMARTAPI_API_KEY,
    });
    instanceCache.set(connectionId, smartApi);
  }

  // Always update the instance with the latest tokens from the session
  // (In case of a re-login while the server is running)
  smartApi.setAccessToken(session.jwtToken);
  smartApi.feedToken = session.feedToken;

  return smartApi;
}

// Default instance for system tasks (using .env)
const defaultSmartApi = new smartapi.SmartAPI({
  api_key: process.env.SMARTAPI_API_KEY,
});

module.exports = {
  getAuthorizedInstance,
  defaultSmartApi
};
