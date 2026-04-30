const postgres = require('postgres');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();

/**
 * DATABASE CONFIGURATION
 * ======================
 * We use 'postgres-js' as a lightweight, high-performance alternative to Prisma.
 * It works perfectly with Supabase's transaction pooler.
 */

const connectionString = process.env.DATABASE_URL;

const sql = postgres(connectionString, {
    /* 
     Supabase Transaction Pooler (Port 6543) settings:
     We set a reasonable max connection limit. 
    */
    max: 10, 
    idle_timeout: 20,
    connect_timeout: 10,
    // Enable transform for camelCase support if desired, 
    // but we'll stick to snake_case to match the DB for simplicity.
});

module.exports = sql;
