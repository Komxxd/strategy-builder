const sql = require('./src/config/db.js');
async function run() {
    try {
        const rows = await sql`SELECT id, status, is_paper_trading, execution_details FROM strategy_executions ORDER BY started_at DESC LIMIT 5`;
        console.log(JSON.stringify(rows, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
run();
