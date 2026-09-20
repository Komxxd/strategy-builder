require('dotenv').config();
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
async function run() {
    const res = await sql`SELECT * FROM strategies LIMIT 1`;
    console.log(JSON.stringify(res[0], null, 2));
    process.exit(0);
}
run();
