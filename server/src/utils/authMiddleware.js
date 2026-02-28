const authMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const serverKey = process.env.SECRET_API_KEY;

    // Only strictly require an API key if one is defined in the server environment
    if (serverKey) {
        if (!apiKey || apiKey !== serverKey) {
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid API Key" });
        }
    }

    next();
};

module.exports = authMiddleware;
