const express = require("express");
const router = express.Router();
const folderCrud = require("../services/trading/folder.crud");

// Get all folders for the user
router.get("/", async (req, res) => {
    try {
        const userId = req.user.id;
        const folders = await folderCrud.getUserFolders(userId);
        res.json({ success: true, data: folders });
    } catch (error) {
        console.error("Error fetching folders:", error);
        res.status(500).json({ success: false, message: "Failed to fetch folders", details: error.message });
    }
});

// Create a new folder
router.post("/", async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, parent_id } = req.body;
        const folder = await folderCrud.createFolder(name, parent_id, userId);
        res.json({ success: true, data: folder });
    } catch (error) {
        console.error("Error creating folder:", error);
        res.status(400).json({ success: false, message: error.message || "Failed to create folder" });
    }
});

// Update a folder
router.put("/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, parent_id } = req.body;
        const folder = await folderCrud.updateFolder(req.params.id, name, parent_id, userId);
        res.json({ success: true, data: folder });
    } catch (error) {
        console.error("Error updating folder:", error);
        res.status(400).json({ success: false, message: error.message || "Failed to update folder" });
    }
});

// Delete a folder
router.delete("/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        await folderCrud.deleteFolder(req.params.id, userId);
        res.json({ success: true, message: "Folder deleted successfully" });
    } catch (error) {
        console.error("Error deleting folder:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to delete folder" });
    }
});

module.exports = router;
