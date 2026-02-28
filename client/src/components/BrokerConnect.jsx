import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { loginBackend } from '../api';
import { Zap, Loader2 } from 'lucide-react';

export function BrokerConnect({ onConnected }) {
    const [loading, setLoading] = useState(false);

    const handleConnect = async () => {
        setLoading(true);
        try {
            const res = await loginBackend();

            if (res.success) {
                onConnected();
            } else {
                alert(res.message || "Failed to connect to Angel One");
            }
        } catch (err) {
            console.error(err);
            alert("Error connecting to broker service");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-[70vh] w-full">
            <Button
                onClick={handleConnect}
                size="lg"
                className="h-16 px-10 gap-3 text-lg font-bold rounded-2xl shadow-xl hover:shadow-2xl transition-all active:scale-95 bg-primary text-primary-foreground"
                disabled={loading}
            >
                {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Zap className="h-6 w-6" />}
                {loading ? 'Activating Connection...' : 'Log into Angel One'}
            </Button>
        </div>
    );
}
