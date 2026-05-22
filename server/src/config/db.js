const postgres = require('postgres');
const net = require('node:net');
require('dotenv').config();

/**
 * DATABASE CONFIGURATION
 * ======================
 */

const connectionString = process.env.DATABASE_URL;

const sql = postgres(connectionString, {
    /* 
     Supabase Transaction Pooler (Port 6543) settings.
     - max: 5 — Reduced from 10. Supavisor has its own pool limits; fewer client-side 
       connections reduces contention and stale-connection errors.
     - idle_timeout: 0 — Don't keep idle connections alive. Supavisor drops them on its 
       side anyway (typically 60s), causing CONNECT_TIMEOUT when we try to reuse them.
     - connect_timeout: 30 — Increased from 10. Cross-cloud (DigitalOcean → Supabase) 
       connections need more headroom, especially under load.
     - max_lifetime: 300 — Force reconnect every 5 minutes. Prevents long-lived connections 
       from going stale behind Supavisor's proxy layer.
    */
    max: 5, 
    idle_timeout: 0,
    connect_timeout: 30,
    max_lifetime: 300,
    
    // FORCE IPv4 ONLY: This fixes the ENETUNREACH error on DigitalOcean
    socket: (options) => {
        const host = Array.isArray(options.host) ? options.host[0] : options.host;
        const port = Array.isArray(options.port) ? options.port[0] : options.port;
        return net.connect({ ...options, host, port, family: 4 });
    }
});

module.exports = sql;
