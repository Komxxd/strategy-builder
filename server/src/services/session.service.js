const NodeCache = require('node-cache');

// Session cache with default TTL of 24 hours (Angel One sessions usually expire daily)
const sessionCache = new NodeCache({ stdTTL: 86400, checkperiod: 600 });

const setSession = (connectionId, sessionData) => {
    return sessionCache.set(`angelone:session:${connectionId}`, sessionData);
};

const getSession = (connectionId) => {
    return sessionCache.get(`angelone:session:${connectionId}`);
};

const deleteSession = (connectionId) => {
    return sessionCache.del(`angelone:session:${connectionId}`);
};

module.exports = {
    setSession,
    getSession,
    deleteSession
};
