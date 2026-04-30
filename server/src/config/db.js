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
     Supabase Transaction Pooler (Port 6543) settings
    */
    max: 10, 
    idle_timeout: 20,
    connect_timeout: 10,
    
    // FORCE IPv4 ONLY: This fixes the ENETUNREACH error on DigitalOcean
    socket: (host, port) => net.connect({ host, port, family: 4 })
});

module.exports = sql;
