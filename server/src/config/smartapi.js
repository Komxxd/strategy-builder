const smartapi = require("smartapi-javascript");
const sessionService = require("../services/session.service");

// Singleton cache to reuse API instances per connection/user
const instanceCache = new Map();

let authErrorCallback = null;
function registerAuthErrorCallback(cb) {
    authErrorCallback = cb;
}

function handlePossibleAuthError(res) {
    if (!res) return false;
    if (res.status === false && (res.errorcode === 'AB1004' || (res.message && (res.message.toLowerCase().includes('token') || res.message.toLowerCase().includes('session expired') || res.message.toLowerCase().includes('unauthorized'))))) {
        console.error("[SmartAPI] Token expiration detected! Forcing global logout...");
        if (authErrorCallback) authErrorCallback();
        return true;
    }
    if (res instanceof Error && res.response && res.response.status === 401) {
        console.error("[SmartAPI] HTTP 401 Unauthorized detected! Forcing global logout...");
        if (authErrorCallback) authErrorCallback();
        return true;
    }
    return false;
}

function createSecureSmartApi(instance) {
    return new Proxy(instance, {
        get(target, propKey) {
            const origMethod = target[propKey];
            if (typeof origMethod === 'function' && propKey !== 'generateSession') {
                return function (...args) {
                    try {
                        const result = origMethod.apply(target, args);
                        if (result && typeof result.then === 'function') {
                            return result.then(resolved => {
                                handlePossibleAuthError(resolved);
                                return resolved;
                            }).catch(err => {
                                handlePossibleAuthError(err);
                                throw err;
                            });
                        }
                        handlePossibleAuthError(result);
                        return result;
                    } catch (err) {
                        handlePossibleAuthError(err);
                        throw err;
                    }
                };
            }
            return origMethod;
        }
    });
}

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
    const rawApi = new smartapi.SmartAPI({
      api_key: session.api_key || process.env.SMARTAPI_API_KEY,
    });
    smartApi = createSecureSmartApi(rawApi);
    instanceCache.set(connectionId, smartApi);
  }

  // Always update the instance with the latest tokens from the session
  // (In case of a re-login while the server is running)
  smartApi.setAccessToken(session.jwtToken);
  smartApi.feedToken = session.feedToken;

  return smartApi;
}

// Default instance for system tasks (using .env)
const rawDefaultSmartApi = new smartapi.SmartAPI({
  api_key: process.env.SMARTAPI_API_KEY,
});

const defaultSmartApi = createSecureSmartApi(rawDefaultSmartApi);

module.exports = {
  getAuthorizedInstance,
  defaultSmartApi,
  registerAuthErrorCallback
};
