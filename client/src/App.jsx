import React, { useState, useEffect } from'react';
import { Routes, Route, Navigate } from'react-router-dom';
import { Button } from'@/components/ui/button';
import { StrategyBuilder } from'./components/StrategyBuilder';
import { LandingPage } from'./components/LandingPage';
import { Auth } from'./components/Auth';
import { UpdatePassword } from './components/UpdatePassword';
import { supabase } from'./lib/supabase';
import {
 AlertCircle, CheckCircle2, Search, LayoutDashboard, Box,
 ShoppingCart, Users, MessageSquare, Mail, Zap, BarChart2,
 Share2, Share, Bell, Folder, Tag, HelpCircle, MessageCircle,
 Settings, Rocket, ChevronRight, Menu, LogOut, Loader2, Lock, History, ChevronLeft,
 Wifi, WifiOff, User
} from'lucide-react';
import { logoutBackend, loginBackend, connectSocket, disconnectSocket, getBrokerStatus, getConnectionStatus } from'./api';
import { StrategyHistory } from'./components/StrategyHistory';
import { BacktestResultsView } from'./components/BacktestResultsView';
import { BrokerSetup } from'./components/BrokerSetup';
import { BrokerCallback } from'./components/BrokerCallback';
import { Profile } from './components/Profile';

import axios from'axios';

// Global Axios Interceptor for Supabase Auth
axios.interceptors.request.use(async (config) => {
 const { data: { session } } = await supabase.auth.getSession();
 const token = session?.access_token;
 if (token && !config.headers['Authorization']) {
 config.headers['Authorization'] =`Bearer ${token}`;
 }
 return config;
});

function App() {
 const [isAuthenticated, setIsAuthenticated] = useState(false);
 const [session, setSession] = useState(null);

 useEffect(() => {
 supabase.auth.getSession().then(({ data: { session } }) => {
 setSession(session);
 setIsAuthenticated(!!session);
 });

 const {
 data: { subscription },
 } = supabase.auth.onAuthStateChange((_event, session) => {
 setSession(session);
 setIsAuthenticated(!!session);
 });

 return () => subscription.unsubscribe();
 }, []);

 // Angel One API session state (login/logout)
 const [isApiConnected, setIsApiConnected] = useState(false);
 // WebSocket live data stream state
 const [isSocketConnected, setIsSocketConnected] = useState(false);
 const [error, setError] = useState(null);
 const [success, setSuccess] = useState(null);
 const [apiLoading, setApiLoading] = useState(false);
 const [socketLoading, setSocketLoading] = useState(false);
 const [activeTab, setActiveTab] = useState('strategies');
 const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

 const [globalBacktestResults, setGlobalBacktestResults] = useState(null);
 const [globalBacktestStrategy, setGlobalBacktestStrategy] = useState(null);

 const handleAuthenticated = () => {
 setSuccess("Access unlocked! Welcome back.");
 };

 // --- Angel One API Pill Handler ---
 const handleToggleApi = async () => {
 setActiveTab('broker');
 };

 // --- WebSocket Pill Handler ---
 const handleToggleSocket = async () => {
 // Note: We skip the`!isApiConnected` check here because the global feed 
 // uses the admin credentials, so it can connect regardless of user session.
 if (isSocketConnected) {
 try {
 setSocketLoading(true);
 await disconnectSocket();
 setIsSocketConnected(false);
 setSuccess("Global WebSocket disconnected.");
 } catch (err) {
 setError("Failed to disconnect WebSocket:" + err.message);
 } finally {
 setSocketLoading(false);
 }
 } else {
 try {
 setSocketLoading(true);
 const res = await connectSocket();
 if (res.success) {
 setIsSocketConnected(true);
 setSuccess("Global WebSocket connecting...");
 } else {
 setError(res.message ||"Failed to connect WebSocket");
 }
 } catch (err) {
 setError("Error connecting WebSocket");
 } finally {
 setSocketLoading(false);
 }
 }
 };

 const handleLogout = async () => {
 await supabase.auth.signOut();
 };

 useEffect(() => {
 if (isAuthenticated) {
 // Auto-sync status with backend on mount/refresh
 const syncStatus = async () => {
 try {
 const res = await getConnectionStatus();
 if (res.success) {
 setIsApiConnected(res.apiConnected);
 setIsSocketConnected(res.socketConnected);
 }
 } catch (err) {
 console.error("Failed to sync initial status:", err);
 }
 };

 syncStatus();
 }
 }, [isAuthenticated]);

 useEffect(() => {
 // Store cleanup in a closure variable so the outer useEffect return can reach it.
 // The previous pattern returned cleanup from inside .then() which React never sees —
 // that makes socket listeners stack on every mount (bad in React Strict Mode dev).
 let cleanup = null;

 import('./api').then(async ({ initSocket }) => {
 const socket = await initSocket();

 // broker_status = Angel One API session (login/logout)
 const handleBrokerStatus = (data) => {
 setIsApiConnected(data.connected);
 if (!data.connected) setIsSocketConnected(false);
 };

 // socket_status = WebSocket data stream only
 const handleSocketStatus = (data) => {
 setIsSocketConnected(data.connected);
 };

 const handleStrategyAlert = (data) => {
 if (data.type ==='success') setSuccess(data.message);
 else setError(data.message);
 };

 socket.on('broker_status', handleBrokerStatus);
 socket.on('socket_status', handleSocketStatus);
 socket.on('strategy_alert', handleStrategyAlert);

 // Store cleanup for when React unmounts or re-runs the effect
 cleanup = () => {
 socket.off('broker_status', handleBrokerStatus);
 socket.off('socket_status', handleSocketStatus);
 socket.off('strategy_alert', handleStrategyAlert);
 };
 });

 // This is what React actually calls on unmount — now it can reach the cleanup
 return () => {
 if (cleanup) cleanup();
 };
 }, []);


  const NavItem = ({ label, active, onClick }) => (
    <button
      onClick={() => { onClick(); setIsMobileMenuOpen(false); }}
      className={`relative h-full w-full lg:w-auto px-4 text-[13px] flex items-center justify-center transition-colors ${active ? 'text-slate-900 font-bold' : 'text-slate-500 font-medium hover:text-slate-800'}`}
    >
      <span className="whitespace-nowrap">{label}</span>
      {active && (
        <span className="hidden lg:block absolute bottom-0 left-0 w-full h-[2px] bg-slate-900 animate-in fade-in duration-300"></span>
      )}
    </button>
  );

 const dashboardElement = (
 <div className="flex flex-col h-screen w-full bg-[#fcfcfc] text-foreground font-sans overflow-hidden">
 
 {/* Top Header */}
      <header className="h-[52px] sm:h-[60px] bg-white border-b flex items-center justify-between px-4 sm:px-6 flex-shrink-0 z-20 transition-all gap-4 relative">
        
        {/* Left: Branding */}
        <div className="flex-1 flex items-center gap-3">
          <div className="h-8 w-8 bg-black rounded-lg flex items-center justify-center text-white shrink-0">
            <Box className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-bold tracking-tight leading-tight whitespace-nowrap hidden sm:block">CoreQuant</h2>
        </div>
          
        {/* Center: Desktop Navigation */}
        <nav className="hidden lg:flex items-center justify-center gap-1 flex-1 absolute left-1/2 -translate-x-1/2 h-full">
           <NavItem label="Strategies" active={activeTab === 'strategies'} onClick={() => setActiveTab('strategies')} />
           <NavItem label="History" active={activeTab === 'history'} onClick={() => setActiveTab('history')} />
           <NavItem label="Backtest Results" active={activeTab === 'backtest'} onClick={() => setActiveTab('backtest')} />
           <NavItem label="Broker Setup" active={activeTab === 'broker'} onClick={() => setActiveTab('broker')} />
        </nav>

        {/* Right Actions */}
        <div className="flex-1 flex items-center justify-end gap-2 sm:gap-4 shrink-0">
 {/* Status Pills */}
 <button
 id="angel-one-status-pill"
 onClick={handleToggleApi}
 title={isApiConnected ?"Angel One session active. Manage in Broker Setup." :"Click to login to Angel One in Broker Setup"}
 className={`flex items-center gap-1.5 px-2 py-1.5 sm:px-3 sm:py-2 rounded-full text-[10px] sm:text-xs font-bold border transition-all cursor-pointer shrink-0 ${isApiConnected
 ?"bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
 :"bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
 }`}
 >
 {isApiConnected ? (
 <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
 ) : (
 <AlertCircle className="h-3.5 w-3.5 shrink-0" />
 )}
 <span className="whitespace-nowrap hidden sm:inline">Angel One</span>
 <span className="whitespace-nowrap sm:hidden">Angel</span>
 </button>

 <button
 id="websocket-status-pill"
 onClick={handleToggleSocket}
 disabled={socketLoading}
 title={
 isSocketConnected
 ?"Live Data Stream Active (Global Feed). Click to disconnect."
 :"Live Data Stream Disconnected. Click to connect."
 }
 className={`flex items-center gap-1.5 px-2 py-1.5 sm:px-3 sm:py-2 rounded-full text-[10px] sm:text-xs font-bold border transition-all shrink-0 cursor-pointer ${
 isSocketConnected
 ?"bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
 :"bg-slate-50 text-slate-500 border-slate-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
 } disabled:opacity-50 disabled:cursor-not-allowed`}
 >
 {socketLoading ? (
 <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
 ) : isSocketConnected ? (
 <Wifi className="h-3.5 w-3.5 shrink-0" />
 ) : (
 <WifiOff className="h-3.5 w-3.5 shrink-0" />
 )}
 <span className="whitespace-nowrap hidden sm:inline">Live Data</span>
 <span className="whitespace-nowrap sm:hidden">Live</span>
 </button>

            <div className="w-px h-6 bg-slate-200 hidden lg:block mx-1"></div>
            
            <button
              onClick={() => setActiveTab('profile')}
              title="User Profile"
              className={`hidden lg:flex px-3 h-8 items-center justify-center rounded-full transition-all border font-bold text-xs ${activeTab === 'profile' ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              <div className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" />
                <span className="truncate max-w-[120px]">
                  {session?.user?.user_metadata?.full_name || session?.user?.email?.split('@')[0] || 'Profile'}
                </span>
              </div>
            </button>
            
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-all hidden lg:flex"
              onClick={handleLogout}
              title="Log Out"
            >
              <LogOut className="h-5 w-5 shrink-0" />
            </Button>
 
 {/* Mobile Menu Toggle */}
 <Button
 variant="ghost"
 size="icon"
 className="lg:hidden text-muted-foreground hover:bg-slate-100 hover:text-foreground shrink-0"
 onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
 >
 <Menu className="h-5 w-5" />
 </Button>
 </div>
 </header>
 
      {/* Mobile/Tablet Dropdown Navigation */}
      {isMobileMenuOpen && (
 <div className="lg:hidden absolute top-[52px] sm:top-[60px] left-0 w-full bg-white border-b z-30 flex flex-col p-4 gap-2 animate-in slide-in-from-top-2">
 <div className="px-3 py-3 mb-2 bg-slate-50 rounded-lg flex items-center gap-3 border border-slate-100">
 <div className="h-9 w-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm">
 {session?.user?.user_metadata?.full_name ? session.user.user_metadata.full_name.charAt(0).toUpperCase() : (session?.user?.email ? session.user.email.charAt(0).toUpperCase() : 'U')}
 </div>
 <div className="flex flex-col">
 <span className="text-sm font-bold text-slate-800">
 {session?.user?.user_metadata?.full_name || session?.user?.email?.split('@')[0] || 'Profile'}
 </span>
 <span className="text-xs text-slate-500 truncate max-w-[200px]">
 {session?.user?.email || 'Logged In'}
 </span>
 </div>
 </div>
 <NavItem label="Strategies" active={activeTab === 'strategies'} onClick={() => setActiveTab('strategies')} />
            <NavItem label="History" active={activeTab === 'history'} onClick={() => setActiveTab('history')} />
            <NavItem label="Backtest Results" active={activeTab === 'backtest'} onClick={() => setActiveTab('backtest')} />
            <NavItem label="Broker Setup" active={activeTab === 'broker'} onClick={() => setActiveTab('broker')} />
            <NavItem label="Profile" active={activeTab === 'profile'} onClick={() => setActiveTab('profile')} />
            <div className="h-px w-full bg-slate-100 my-2"></div>
            <Button
              variant="ghost"
              className="w-full justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600 transition-all"
              onClick={() => { handleLogout(); setIsMobileMenuOpen(false); }}
            >
              <LogOut className="h-4 w-4 shrink-0" />
              Log Out
            </Button>
         </div>
      )}

 {/* Main Container */}
 <main className="flex-1 flex flex-col h-full overflow-hidden bg-background md:bg-[#FAFAFA] relative">



 {/* Content Area */}
 <div className={`flex-1 overflow-y-auto custom-scrollbar relative ${activeTab ==='backtest' ?'p-0' :'p-4 sm:p-8'}`}>

 <div className={`${activeTab ==='backtest' ?'w-full h-full flex flex-col' :'max-w-[1400px] mx-auto space-y-6'}`}>
 {error && (
 <div className="p-4 bg-red-50 border border-red-100 text-red-700 rounded-lg flex items-center gap-3 animate-in slide-in-from-top-2">
 <AlertCircle className="h-5 w-5" />
 <p className="text-sm font-medium">{error}</p>
 <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setError(null)}>Dismiss</Button>
 </div>
 )}

 {success && (
 <div className="p-4 bg-green-50 border border-green-100 text-green-700 rounded-lg flex items-center gap-3 animate-in slide-in-from-top-2">
 <CheckCircle2 className="h-5 w-5" />
 <p className="text-sm font-medium">{success}</p>
 <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSuccess(null)}>Dismiss</Button>
 </div>
 )}

 <div className={`w-full flex-1 animate-in fade-in duration-500 ${activeTab ==='backtest' ?'h-full' :'pb-20'}`}>
 {activeTab ==='strategies' ? (
 <StrategyBuilder
 isConnected={isApiConnected && isSocketConnected}
 onBacktestComplete={(results, strategy) => {
 setGlobalBacktestResults(results);
 setGlobalBacktestStrategy(strategy);
 setActiveTab('backtest');
 }}
 />
 ) : activeTab ==='history' ? (
 <StrategyHistory />
 ) : activeTab ==='backtest' ? (
 <BacktestResultsView
 results={globalBacktestResults}
 strategy={globalBacktestStrategy}
 />
 ) : activeTab === 'profile' ? (
 <Profile />
 ) : (
 <BrokerSetup />
 )}
 </div>
 </div>

 </div>
 </main>
 </div>
 );

 return (
 <Routes>
  <Route path="/login" element={!isAuthenticated ? <Auth onAuthenticated={handleAuthenticated} defaultView="login" /> : <Navigate to="/" />} />
  <Route path="/register" element={!isAuthenticated ? <Auth onAuthenticated={handleAuthenticated} defaultView="register" /> : <Navigate to="/" />} />
  <Route path="/update-password" element={<UpdatePassword />} />
  <Route path="/broker-callback" element={isAuthenticated ? <BrokerCallback /> : <Navigate to="/" replace />} />
  <Route path="/" element={isAuthenticated ? dashboardElement : <LandingPage />} />
  <Route path="*" element={<Navigate to="/" replace />} />
 </Routes>
 );
}

export default App;
