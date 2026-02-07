const supabase = require("../config/supabase");

const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ success: false, message: "No authorization header" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ success: false, message: "No token provided" });
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({ success: false, message: "Invalid or expired token" });
        }

        req.user = user;
        next();
    } catch (err) {
        console.error("Auth middleware error:", err);
        return res.status(500).json({ success: false, message: "Authentication failed" });
    }
};

module.exports = authMiddleware;
