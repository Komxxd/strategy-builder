import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { loginBackend } from '../api';
import { Shield, Zap, Loader2 } from 'lucide-react';

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
        <Card className="w-full max-w-md mx-auto overflow-hidden relative border-border bg-card">

            <CardHeader className="text-center pb-2">
                <div className="flex justify-center mb-4">
                    <div className="p-3 bg-muted rounded-2xl animate-pulse">
                        <Shield className="h-8 w-8 text-primary" />
                    </div>
                </div>
                <CardTitle className="text-3xl font-black tracking-tight">Activate Terminal</CardTitle>
                <CardDescription className="text-base">
                    Connect to the Angel One market using system credentials.
                </CardDescription>
            </CardHeader>

            <CardContent className="pt-6 space-y-6">
                <div className="p-4 bg-muted rounded-2xl space-y-3 border border-border">
                    <div className="flex gap-3 items-start">
                        <div className="mt-1 p-1 bg-green-100 rounded-full">
                            <Zap className="h-3 w-3 text-green-500" />
                        </div>
                        <p className="text-sm font-medium">Safe & Secure Execution</p>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed pl-7">
                        One-click connection to the live market. No personal broker credentials required from your end.
                        We use the platform's root account for all execution and research data.
                    </p>
                </div>

                <div className="flex items-center gap-2 p-3 px-4 bg-blue-50 rounded-xl text-[11px] text-blue-600 font-bold uppercase tracking-wider">
                    <Shield className="h-3.5 w-3.5" />
                    Production Ready Environment
                </div>
            </CardContent>

            <CardFooter className="pb-8 pt-2">
                <Button
                    onClick={handleConnect}
                    className="w-full h-14 gap-3 text-lg font-bold rounded-2xl shadow-lg hover:shadow-xl transition-all active:scale-95"
                    disabled={loading}
                >
                    {loading ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                        <Zap className="h-5 w-5" />
                    )}
                    {loading ? 'Activating Express...' : 'Initialize Live Connection'}
                </Button>
            </CardFooter>
        </Card>
    );
}
