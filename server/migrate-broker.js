require('dotenv').config();
const postgres = require('postgres');

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false }
});

async function main() {
    try {
        console.log("Creating user_broker_credentials table...");
        await sql`
            CREATE TABLE IF NOT EXISTS user_broker_credentials (
                user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
                api_key TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `;
        console.log("Table created successfully!");
    } catch (err) {
        console.error("Migration failed:", err);
    } finally {
        await sql.end();
    }
}

main();
