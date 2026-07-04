const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

let supabase;
if (supabaseUrl && supabaseAnonKey) {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
    console.warn("WARNING: SUPABASE_URL or SUPABASE_ANON_KEY is missing in server environment.");
}

const authMiddleware = async (req, res, next) => {
    // If Supabase is not configured, we should fail secure
    if (!supabase) {
        return res.status(500).json({ success: false, message: "Authentication service not configured." });
    }

    const authHeader = req.headers['authorization'];
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: "Unauthorized: Missing or invalid token" });
    }

    const token = authHeader.split(' ')[1];
    
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            return res.status(401).json({ success: false, message: "Unauthorized: Invalid token" });
        }
        
        req.user = user;
        next();
    } catch (err) {
        console.error("Auth Error:", err);
        return res.status(500).json({ success: false, message: "Internal server error during authentication" });
    }
};

module.exports = authMiddleware;
