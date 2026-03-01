import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Unlock, AlertCircle, Loader2 } from 'lucide-react';
import { verifyPassword } from '../api';

export function PasswordLock({ onAuthenticated }) {
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Tier 1 - Rule 1 & Phase 2: Backend-led verification
            const res = await verifyPassword(password);

            if (res.success && res.apiKey) {
                // Securely store for the session to avoid hardcoded VITE_ API keys
                sessionStorage.setItem('app_api_key', res.apiKey);
                onAuthenticated();
            } else {
                setError(res.message || "Invalid password. Access denied.");
                setPassword('');
            }
        } catch (err) {
            setError("Authentication service unavailable. Try again later.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-[70vh] w-full px-4 animate-in fade-in duration-500">
            <div className="w-full max-w-md bg-white p-8 rounded-3xl shadow-2xl border border-gray-100 flex flex-col items-center gap-6">
                <div className="h-16 w-16 bg-primary/10 rounded-2xl flex items-center justify-center text-primary">
                    <Lock className="h-8 w-8" />
                </div>

                <div className="text-center space-y-2">
                    <h2 className="text-2xl font-bold tracking-tight">System Locked</h2>
                    <p className="text-muted-foreground text-sm">Please enter your secret password to access CoreQuant</p>
                </div>

                <form onSubmit={handleSubmit} className="w-full space-y-4">
                    <div className="space-y-2">
                        <Input
                            type="password"
                            placeholder="Enter password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="h-12 border-gray-200 focus:ring-primary focus:border-primary rounded-xl px-4"
                            autoFocus
                        />
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 text-destructive text-sm font-medium animate-in slide-in-from-top-1">
                            <AlertCircle className="h-4 w-4" />
                            <span>{error}</span>
                        </div>
                    )}

                    <Button
                        type="submit"
                        disabled={loading || !password}
                        className="w-full h-12 gap-2 text-base font-bold rounded-xl shadow-lg hover:shadow-xl transition-all active:scale-[0.98]"
                    >
                        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Unlock className="h-5 w-5" />}
                        {loading ? 'Verifying...' : 'Unlock App'}
                    </Button>
                </form>
            </div>
        </div>
    );
}
