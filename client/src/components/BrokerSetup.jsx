import React, { useState, useEffect } from'react';
import { Button } from'@/components/ui/button';
import { supabase } from'@/lib/supabase';
import { Key, Link as LinkIcon, CheckCircle2, AlertCircle, Loader2 } from'lucide-react';
import { useSearchParams } from'react-router-dom';
import { getBrokerCredentials, saveBrokerCredentials, logoutUserBroker, getWorkerNode, provisionWorkerNode } from'../api';
import { Copy } from'lucide-react';

const CALLBACK_URL =`${window.location.origin}/broker-callback`;

export function BrokerSetup() {
 const [apiKey, setApiKey] = useState("");
 const [savedApiKey, setSavedApiKey] = useState(null);
 const [isActive, setIsActive] = useState(false);
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState(null);
 const [success, setSuccess] = useState(null);

 // VEE (Virtual Execution Environment) States
 const [workerIp, setWorkerIp] = useState(null);
 const [workerStatus, setWorkerStatus] = useState(null);
 const [isProvisioning, setIsProvisioning] = useState(false);

 const [searchParams] = useSearchParams();

 const fetchCredentials = async () => {
 try {
 setLoading(true);
 const data = await getBrokerCredentials();
 if (data.success) {
 if (data.apiKey) {
 setApiKey(data.apiKey);
 setSavedApiKey(data.apiKey);
 }
 setIsActive(data.isActive);
 }

 const workerData = await getWorkerNode();
 if (workerData.success && workerData.hasWorker) {
 setWorkerIp(workerData.ip);
 setWorkerStatus(workerData.status);
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
 const data = await saveBrokerCredentials(apiKey);
 if (data.success) {
 setSuccess("API Key saved successfully!");
 setSavedApiKey(apiKey);
 } else {
 setError(data.message ||"Failed to save API Key");
 }
 } catch (err) {
 setError(err.message ||"Failed to save API Key");
 } finally {
 setLoading(false);
 }
 };

 const handleLoginBroker = () => {
 if (!savedApiKey) {
 setError("Please save your API Key first.");
 return;
 }

 const angelOneLoginUrl =`https://smartapi.angelbroking.com/publisher-login/?api_key=${savedApiKey}&redirect_url=${encodeURIComponent(CALLBACK_URL)}`;
 window.location.href = angelOneLoginUrl;
 };

 const handleProvisionWorker = async () => {
 try {
 setIsProvisioning(true);
 setError(null);
 const data = await provisionWorkerNode();
 if (data.success) {
 setWorkerIp(data.ip);
 setWorkerStatus('PROVISIONING'); // Or ACTIVE if it returns it
 setSuccess("Dedicated Virtual Environment allocated successfully!");
 } else {
 setError(data.message ||"Failed to allocate Virtual Environment.");
 }
 } catch (err) {
 setError(err.message ||"Failed to allocate Virtual Environment.");
 } finally {
 setIsProvisioning(false);
 }
 };

 const handleCopyIp = () => {
 if (workerIp) {
 navigator.clipboard.writeText(workerIp);
 setSuccess("IP Address copied to clipboard!");
 setTimeout(() => setSuccess(null), 3000);
 }
 };

 const handleLogoutBroker = async () => {
 try {
 setLoading(true);
 const data = await logoutUserBroker();
 if (data.success) {
 setIsActive(false);
 setSuccess("Broker disconnected successfully.");
 } else {
 setError(data.message ||"Failed to disconnect broker.");
 }
 } catch (err) {
 setError(err.message ||"Failed to disconnect broker.");
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="max-w-4xl mx-auto space-y-6">
 <div className="bg-white rounded-xl border p-6">
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
 {/* Left Column: Instructions & Setup */}
 <div className="space-y-6">
 {/* Step 1: Virtual Environment */}
 <div className="bg-slate-50 p-5 rounded-xl border border-slate-100 space-y-4">
 <h3 className="font-semibold text-sm">Step 1: Allocate Dedicated IP</h3>
 <p className="text-xs text-slate-600">
 Angel One requires every trading account to have a unique static IP.
 We will spin up a dedicated Virtual Execution Environment just for you.
 </p>

 {workerIp ? (
 <div className="p-3 bg-white border rounded-lg flex items-center justify-between">
 <div>
 <p className="text-xs text-slate-500 font-semibold mb-1">Your Dedicated IP</p>
 <p className="font-mono font-bold text-slate-800">{workerIp}</p>
 </div>
 <Button variant="outline" size="sm" onClick={handleCopyIp}>
 <Copy className="h-4 w-4 mr-2" /> Copy
 </Button>
 </div>
 ) : (
 <Button
 className="w-full bg-blue-600 hover:bg-blue-700"
 onClick={handleProvisionWorker}
 disabled={isProvisioning}
 >
 {isProvisioning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
 {isProvisioning ?"Allocating Server (takes ~30s)..." :"Allocate Dedicated IP"}
 </Button>
 )}
 </div>

 {/* Step 2: Instructions */}
 <div className="bg-slate-50 p-5 rounded-xl border border-slate-100 space-y-4">
 <h3 className="font-semibold text-sm">Step 2: SmartAPI Setup</h3>
 <ol className="list-decimal list-inside text-sm text-slate-600 space-y-3">
 <li>Go to the <a href="https://smartapi.angelone.in/" target="_blank" rel="noopener noreferrer" className="text-blue-600 font-medium hover:underline">SmartAPI portal</a> and login to your account.</li>
 <li>Create a new App with the name CoreQuant.</li>
 <li>Paste your Dedicated IP (from Step 1) into the <strong>Client IP</strong> field.</li>
 <li>When creating the app, copy and paste this exact URL as your <strong>Redirect URL</strong>:</li>
 <code className="block p-2 mt-2 bg-slate-200 text-slate-800 rounded text-xs select-all overflow-x-auto">
 {CALLBACK_URL}
 </code>
 <li>Enter the generated <strong>API Key</strong> in the form.</li>
 </ol>
 </div>
 </div>

 {/* Right Column: Form */}
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
