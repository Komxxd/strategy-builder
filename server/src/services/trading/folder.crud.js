const sql = require("../../config/db");
const { withDbRetry } = require("./strategy.crud");

const fixTimezone = (date) => {
    if (!date) return null;
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000);
};

async function createFolder(name, parentId, userId) {
    if (!name || name.trim() === '') {
        throw new Error("Folder name is required.");
    }

    // Check if folder with same name exists at the same level
    const existing = await withDbRetry(() => sql`
        SELECT id FROM strategy_folders 
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(${name}))
        AND user_id = ${userId}
        AND parent_id ${parentId ? sql`= ${parentId}` : sql`IS NULL`}
        LIMIT 1
    `);

    if (existing.length > 0) {
        throw new Error(`A folder named "${name}" already exists here.`);
    }

    const [data] = await withDbRetry(() => sql`
        INSERT INTO strategy_folders (name, parent_id, user_id)
        VALUES (${name.trim()}, ${parentId || null}, ${userId})
        RETURNING *
    `);

    return {
        ...data,
        created_at: fixTimezone(data.created_at),
        updated_at: fixTimezone(data.updated_at)
    };
}

async function updateFolder(folderId, name, parentId, userId) {
    if (!name || name.trim() === '') {
        throw new Error("Folder name is required.");
    }

    // Check for duplicates
    const existing = await withDbRetry(() => sql`
        SELECT id FROM strategy_folders 
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(${name}))
        AND user_id = ${userId}
        AND parent_id ${parentId ? sql`= ${parentId}` : sql`IS NULL`}
        AND id != ${folderId}
        LIMIT 1
    `);

    if (existing.length > 0) {
        throw new Error(`A folder named "${name}" already exists here.`);
    }

    // Prevent cyclic parent references (basic check: can't be its own parent)
    if (parentId === folderId) {
        throw new Error("A folder cannot be its own parent.");
    }

    const [data] = await withDbRetry(() => sql`
        UPDATE strategy_folders
        SET name = ${name.trim()}, parent_id = ${parentId || null}, updated_at = NOW()
        WHERE id = ${folderId} AND user_id = ${userId}
        RETURNING *
    `);

    if (!data) throw new Error("Folder not found");

    return {
        ...data,
        created_at: fixTimezone(data.created_at),
        updated_at: fixTimezone(data.updated_at)
    };
}

async function deleteFolder(folderId, userId) {
    // Due to ON DELETE CASCADE on strategy_folders(parent_id) and ON DELETE SET NULL on strategies(folder_id)
    // Deleting a folder will automatically cascade delete subfolders and unset folder_id for strategies inside.
    await withDbRetry(() => sql`
        DELETE FROM strategy_folders
        WHERE id = ${folderId} AND user_id = ${userId}
    `);
    return true;
}

async function getUserFolders(userId) {
    const data = await withDbRetry(() => sql`
        SELECT * FROM strategy_folders
        WHERE user_id = ${userId}
        ORDER BY name ASC
    `);

    return data.map(f => ({
        ...f,
        created_at: fixTimezone(f.created_at),
        updated_at: fixTimezone(f.updated_at)
    }));
}

module.exports = {
    createFolder,
    updateFolder,
    deleteFolder,
    getUserFolders
};
