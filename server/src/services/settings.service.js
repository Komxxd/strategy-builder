const sql = require("../config/db");
const { withDbRetry } = require("./trading/strategy.crud");

async function getSettings(userId) {
    const data = await withDbRetry(() =>
        sql`SELECT * FROM user_settings WHERE user_id = ${userId}`
    );
    
    if (data.length === 0) {
        return {
            custom_strategy_order: [],
            custom_folder_order: []
        };
    }
    
    return {
        custom_strategy_order: data[0].custom_strategy_order || [],
        custom_folder_order: data[0].custom_folder_order || []
    };
}

async function updateSettings(userId, settings) {
    const existing = await withDbRetry(() =>
        sql`SELECT 1 FROM user_settings WHERE user_id = ${userId}`
    );
    
    if (existing.length === 0) {
        // Insert
        const [data] = await withDbRetry(() =>
            sql`
            INSERT INTO user_settings (user_id, custom_strategy_order, custom_folder_order)
            VALUES (${userId}, ${sql.json(settings.custom_strategy_order || [])}, ${sql.json(settings.custom_folder_order || [])})
            RETURNING *
            `
        );
        return data;
    } else {
        // Update
        // Build dynamic update
        const updates = {};
        if (settings.custom_strategy_order !== undefined) {
            updates.custom_strategy_order = sql.json(settings.custom_strategy_order);
        }
        if (settings.custom_folder_order !== undefined) {
            updates.custom_folder_order = sql.json(settings.custom_folder_order);
        }
        updates.updated_at = sql`NOW()`;

        const [data] = await withDbRetry(() =>
            sql`
            UPDATE user_settings 
            SET ${sql(updates)}
            WHERE user_id = ${userId}
            RETURNING *
            `
        );
        return data;
    }
}

module.exports = {
    getSettings,
    updateSettings
};
