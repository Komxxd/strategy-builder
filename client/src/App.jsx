import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { StrategyBuilder } from './components/StrategyBuilder';
import { LandingPage } from './components/LandingPage';
import { Auth } from './components/Auth';
import { supabase } from './lib/supabase';
import {
  AlertCircle, CheckCircle2, Search, LayoutDashboard, Box,
  ShoppingCart, Users, MessageSquare, Mail, Zap, BarChart2,
  Share2, Share, Bell, Folder, Tag, HelpCircle, MessageCircle,
  Settings, Rocket, ChevronRight, Menu, LogOut, Loader2, Lock, History, ChevronLeft,
  Wifi, WifiOff
} from 'lucide-react';
import { logoutBackend, loginBackend, connectSocket, disconnectSocket, getBrokerStatus, getConnectionStatus } from './api';
import { StrategyHistory } from './components/StrategyHistory';
import { BacktestResultsView } from './components/BacktestResultsView';
import { BrokerSetup } from './components/BrokerSetup';
import { BrokerCallback } from './components/BrokerCallback';

import axios from 'axios';

// Global Axios Interceptor for Supabase Auth
axios.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (token && !config.headers['Authorization']) {
    config.headers['Authorization'] = `Bearer ${token}`;
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);

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
    if (!isApiConnected) {
      setError("Login to Angel One first before connecting WebSocket.");
      return;
    }
    if (isSocketConnected) {
      try {
        setSocketLoading(true);
        await disconnectSocket();
        setIsSocketConnected(false);
        setSuccess("WebSocket disconnected.");
      } catch (err) {
        setError("Failed to disconnect WebSocket: " + err.message);
      } finally {
        setSocketLoading(false);
      }
    } else {
      try {
        setSocketLoading(true);
        const res = await connectSocket();
        if (res.success) {
          // Optimistic update: turn the pill blue immediately so the user
          // knows their click registered. If the WebSocket actually fails to
          // connect, the server will emit socket_status: false which will
          // correct this back to grey automatically.
          setIsSocketConnected(true);
          setSuccess("WebSocket connecting...");
        } else {
          setError(res.message || "Failed to connect WebSocket");
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

    import('./api').then(({ initSocket }) => {
      const socket = initSocket();

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
        if (data.type === 'success') setSuccess(data.message);
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


  const SidebarItem = ({ icon: Icon, label, active, onClick, badge, isCollapsed }) => (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'} ${isCollapsed ? 'justify-center' : ''}`}
      title={isCollapsed ? label : ''}
    >
      <div className={`flex items-center ${isCollapsed ? 'justify-center w-full' : 'gap-3'}`}>
        <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-primary' : ''}`} />
        {!isCollapsed && <span className="whitespace-nowrap">{label}</span>}
      </div>
      {!isCollapsed && badge && <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground text-[10px] font-bold shrink-0">{badge}</span>}
    </button>
  );

  const dashboardElement = (
    <div className="flex h-screen w-full bg-[#fcfcfc] text-foreground font-sans overflow-hidden">

      {/* Sidebar */}
      <aside className={`${isSidebarCollapsed ? 'hidden md:flex md:w-[80px]' : 'flex w-[280px] sm:w-[260px] absolute md:relative z-50 h-[100dvh] shadow-2xl md:shadow-none'} transition-all duration-300 flex-shrink-0 border-r bg-white flex flex-col`}>
        <div className={`h-[76px] ${isSidebarCollapsed ? 'px-0 justify-center' : 'px-4 justify-between'} border-b flex-shrink-0 flex items-center overflow-hidden`}>
          {!isSidebarCollapsed && (
            <div className="flex items-center gap-3 px-2 py-1.5">
              <div className="h-8 w-8 bg-black rounded-lg flex items-center justify-center text-white shrink-0">
                <Box className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-bold tracking-tight leading-tight whitespace-nowrap">CoreQuant</h2>
              </div>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex text-muted-foreground hover:bg-slate-100 hover:text-foreground shrink-0"
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          >
            <Menu className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 custom-scrollbar">

          <div className="space-y-1">
            {!isSidebarCollapsed && <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 whitespace-nowrap">Main Menu</p>}
            {isSidebarCollapsed && <div className="h-4"></div>}
            <SidebarItem
              icon={LayoutDashboard}
              label="Strategies"
              active={activeTab === 'strategies'}
              onClick={() => setActiveTab('strategies')}
              isCollapsed={isSidebarCollapsed}
            />
            <SidebarItem
              icon={History}
              label="History"
              active={activeTab === 'history'}
              onClick={() => setActiveTab('history')}
              isCollapsed={isSidebarCollapsed}
            />
            <SidebarItem
              icon={BarChart2}
              label="Backtest Results"
              active={activeTab === 'backtest'}
              onClick={() => setActiveTab('backtest')}
              isCollapsed={isSidebarCollapsed}
            />
            <SidebarItem
              icon={CheckCircle2} // using CheckCircle2 as a placeholder for broker setup, or we can use Settings
              label="Broker Setup"
              active={activeTab === 'broker'}
              onClick={() => setActiveTab('broker')}
              isCollapsed={isSidebarCollapsed}
            />
          </div>

        </div>

        <div className="p-4 border-t flex flex-col items-center">
          <Button
            variant="ghost"
            className={`w-full ${isSidebarCollapsed ? 'justify-center px-0' : 'justify-start gap-3'} text-muted-foreground hover:text-foreground hover:bg-red-50 hover:text-red-600 transition-all rounded-xl`}
            onClick={handleLogout}
            title={isSidebarCollapsed ? "Log Out" : ""}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!isSidebarCollapsed && <span className="whitespace-nowrap">Log Out</span>}
          </Button>
        </div>
      </aside>

      {/* Main Container */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-background md:bg-[#FAFAFA]">

        <header className="h-[64px] sm:h-[76px] bg-white border-b flex flex-nowrap items-center justify-between px-2 sm:px-6 flex-shrink-0 z-10 transition-all gap-2 overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1 sm:gap-4 shrink-0">
            <div className="flex items-center md:hidden">
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}>
                <Menu className="h-5 w-5" />
              </Button>
            </div>
            <h1 className="text-[15px] sm:text-2xl font-bold tracking-tight text-foreground whitespace-nowrap">
              {activeTab === 'strategies' ? 'Strategies' : activeTab === 'history' ? 'Execution History' : activeTab === 'backtest' ? 'Backtest Results' : 'Broker Setup'}
            </h1>
          </div>

          {/* Two independent status pills */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">

            {/* Pill 1: Angel One API Session */}
            <button
              id="angel-one-status-pill"
              onClick={handleToggleApi}
              title={isApiConnected ? "Angel One session active. Manage in Broker Setup." : "Click to login to Angel One in Broker Setup"}
              className={`flex items-center gap-1.5 px-2 py-1 sm:px-3 sm:py-2 rounded-full text-[10px] sm:text-xs font-bold border transition-all cursor-pointer shadow-sm shrink-0 ${isApiConnected
                ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                : "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
                }`}
            >
              {isApiConnected ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="whitespace-nowrap">Angel One</span>
            </button>

            {/* Pill 2: WebSocket Data Stream */}
            <button
              id="websocket-status-pill"
              onClick={handleToggleSocket}
              disabled={socketLoading || !isApiConnected}
              title={
                !isApiConnected
                  ? "Login to Angel One first"
                  : isSocketConnected
                    ? "WebSocket streaming. Click to disconnect."
                    : "Click to connect WebSocket data stream"
              }
              className={`flex items-center gap-1.5 px-2 py-1 sm:px-3 sm:py-2 rounded-full text-[10px] sm:text-xs font-bold border transition-all shadow-sm shrink-0 ${!isApiConnected
                ? "bg-slate-50 text-slate-400 border-slate-200 cursor-not-allowed"
                : isSocketConnected
                  ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200 cursor-pointer"
                  : "bg-slate-50 text-slate-500 border-slate-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 cursor-pointer"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {socketLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              ) : isSocketConnected ? (
                <Wifi className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="whitespace-nowrap">WebSocket</span>
            </button>

          </div>
        </header>

        {/* Content Area */}
        <div className={`flex-1 overflow-y-auto custom-scrollbar relative ${activeTab === 'backtest' ? 'p-0' : 'p-4 sm:p-8'}`}>

          <div className={`${activeTab === 'backtest' ? 'w-full h-full flex flex-col' : 'max-w-[1400px] mx-auto space-y-6'}`}>
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

            <div className={`w-full flex-1 animate-in fade-in duration-500 ${activeTab === 'backtest' ? 'h-full' : 'pb-20'}`}>
              {activeTab === 'strategies' ? (
                <StrategyBuilder
                  isConnected={isApiConnected && isSocketConnected}
                  onBacktestComplete={(results, strategy) => {
                    setGlobalBacktestResults(results);
                    setGlobalBacktestStrategy(strategy);
                    setActiveTab('backtest');
                  }}
                />
              ) : activeTab === 'history' ? (
                <StrategyHistory />
              ) : activeTab === 'backtest' ? (
                <BacktestResultsView
                  results={globalBacktestResults}
                  strategy={globalBacktestStrategy}
                />
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
      <Route path="/" element={isAuthenticated ? dashboardElement : <LandingPage />} />
      <Route path="/broker-callback" element={isAuthenticated ? <BrokerCallback /> : <Navigate to="/" replace />} />
      <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <Auth onAuthenticated={handleAuthenticated} defaultView="login" />} />
      <Route path="/register" element={isAuthenticated ? <Navigate to="/" replace /> : <Auth onAuthenticated={handleAuthenticated} defaultView="signup" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;

