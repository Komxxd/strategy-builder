import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import axios from 'axios';
import { Key, Link as LinkIcon, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

const CALLBACK_URL = `${window.location.origin}/broker-callback`;

export function BrokerSetup() {
    const [apiKey, setApiKey] = useState("");
    const [savedApiKey, setSavedApiKey] = useState(null);
    const [isActive, setIsActive] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);

    const [searchParams] = useSearchParams();

    const fetchCredentials = async () => {
        try {
            setLoading(true);
            const res = await axios.get('/api/broker/credentials');
            if (res.data.success) {
                if (res.data.apiKey) {
                    setApiKey(res.data.apiKey);
                    setSavedApiKey(res.data.apiKey);
                }
                setIsActive(res.data.isActive);
            }
        } catch (err) {
            console.error(err);
            setError("Failed to load broker credentials");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCredentials();
    }, []);

    const handleSave = async () => {
        try {
            setLoading(true);
            setError(null);
            setSuccess(null);
            const res = await axios.post('/api/broker/credentials', { apiKey });
            if (res.data.success) {
                setSuccess("API Key saved successfully!");
                setSavedApiKey(apiKey);
            }
        } catch (err) {
            setError(err.response?.data?.message || "Failed to save API Key");
        } finally {
            setLoading(false);
        }
    };

    const handleLoginBroker = () => {
        if (!savedApiKey) {
            setError("Please save your API Key first.");
            return;
        }
        
        // This is exactly how AlgoTest redirects to the Publisher API
        const angelOneLoginUrl = `https://smartapi.angelbroking.com/publisher-login/?api_key=${savedApiKey}&redirect_url=${encodeURIComponent(CALLBACK_URL)}`;
        window.location.href = angelOneLoginUrl;
    };

    const handleLogoutBroker = async () => {
        try {
            setLoading(true);
            const res = await axios.post('/api/broker/logout');
            if (res.data.success) {
                setIsActive(false);
                setSuccess("Broker disconnected successfully.");
            }
        } catch (err) {
            setError("Failed to disconnect broker.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="bg-white rounded-xl shadow-sm border p-6">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                        <LinkIcon className="h-5 w-5" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold tracking-tight">Broker Setup (Angel One)</h2>
                        <p className="text-sm text-muted-foreground">Connect your personal Angel One account to execute strategies.</p>
                    </div>
                </div>

                {error && (
                    <div className="p-4 mb-6 bg-red-50 border border-red-100 text-red-700 rounded-lg flex items-center gap-3">
                        <AlertCircle className="h-5 w-5" />
                        <p className="text-sm font-medium">{error}</p>
                    </div>
                )}
                {success && (
                    <div className="p-4 mb-6 bg-green-50 border border-green-100 text-green-700 rounded-lg flex items-center gap-3">
                        <CheckCircle2 className="h-5 w-5" />
                        <p className="text-sm font-medium">{success}</p>
                    </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Instructions */}
                    <div className="bg-slate-50 p-5 rounded-xl border border-slate-100 space-y-4">
                        <h3 className="font-semibold text-sm">How to Connect</h3>
                        <ol className="list-decimal list-inside text-sm text-slate-600 space-y-3">
                            <li>Go to the <a href="https://smartapi.angelone.in/" target="_blank" rel="noopener noreferrer" className="text-blue-600 font-medium hover:underline">SmartAPI portal</a> and login to your account.</li>
                            <li>Create a new App with the name <strong>AlgoTest</strong> (or CoreQuant).</li>
                            <li>When creating the app, copy and paste this exact URL as your <strong>Redirect URL</strong>:</li>
                            <code className="block p-2 mt-2 bg-slate-200 text-slate-800 rounded text-xs select-all overflow-x-auto">
                                {CALLBACK_URL}
                            </code>
                            <li>Enter the generated <strong>API Key</strong> in the form below.</li>
                        </ol>
                    </div>

                    {/* Form */}
                    <div className="space-y-5">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-700">Angel One API Key</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Key className="h-4 w-4 text-slate-400" />
                                </div>
                                <input
                                    type="text"
                                    value={apiKey}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    placeholder="Enter your SmartAPI Key"
                                    className="w-full pl-9 pr-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono text-sm"
                                />
                            </div>
                        </div>

                        <Button 
                            className="w-full font-semibold" 
                            onClick={handleSave} 
                            disabled={loading || !apiKey}
                        >
                            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Save API Key
                        </Button>

                        <div className="pt-6 border-t space-y-4">
                            <h3 className="font-semibold text-sm text-slate-700">Daily Authentication</h3>
                            <p className="text-xs text-slate-500">You must log in to your broker every morning before trading begins to authorize the connection for the day.</p>
                            
                            {isActive ? (
                                <div className="flex flex-col gap-3">
                                    <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-lg flex items-center gap-3">
                                        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                                        <div className="flex-1">
                                            <p className="text-sm font-bold text-emerald-800">Broker Connected</p>
                                            <p className="text-xs text-emerald-600">Your session is active for today.</p>
                                        </div>
                                    </div>
                                    <Button variant="outline" className="w-full text-red-600 hover:text-red-700 hover:bg-red-50" onClick={handleLogoutBroker}>
                                        Disconnect Broker
                                    </Button>
                                </div>
                            ) : (
                                <Button 
                                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold" 
                                    onClick={handleLoginBroker}
                                    disabled={!savedApiKey || loading}
                                >
                                    Login to Angel One
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
