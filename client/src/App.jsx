import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { StrategyBuilder } from './components/StrategyBuilder';
import { BrokerConnect } from './components/BrokerConnect';
import {
  AlertCircle, CheckCircle2, Search, LayoutDashboard, Box,
  ShoppingCart, Users, MessageSquare, Mail, Zap, BarChart2,
  Share2, Share, Bell, Folder, Tag, HelpCircle, MessageCircle,
  Settings, Rocket, ChevronRight, Menu
} from 'lucide-react';
import axios from 'axios';

// Globally attach backend secret
axios.defaults.headers.common['x-api-key'] = import.meta.env.VITE_API_KEY || "my-super-secret-local-api-key-123";

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    import('./api').then(({ initSocket }) => {
      const socket = initSocket();

      const handleBrokerStatus = (data) => {
        setIsConnected(data.connected);
        if (!data.connected) {
          console.log("Broker disconnected or server restarted.");
        }
      };

      socket.on('broker_status', handleBrokerStatus);

      return () => {
        socket.off('broker_status', handleBrokerStatus);
      };
    });
  }, []);

  const SidebarItem = ({ icon: Icon, label, active, badge }) => (
    <button className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
      <div className="flex items-center gap-3">
        <Icon className={`h-4 w-4 ${active ? 'text-primary' : ''}`} />
        <span>{label}</span>
      </div>
      {badge && <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground text-[10px] font-bold">{badge}</span>}
    </button>
  );

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#fcfcfc] text-foreground font-sans w-full">
        <BrokerConnect onConnected={() => {
          setIsConnected(true);
          setSuccess("Successfully connected to the live market!");
        }} />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-[#fcfcfc] text-foreground font-sans overflow-hidden">

      {/* Sidebar */}
      <aside className="w-[260px] flex-shrink-0 border-r bg-white h-full flex flex-col hidden md:flex">
        <div className="h-[76px] px-4 border-b flex-shrink-0 flex items-center">
          <div className="w-full flex items-center gap-3 px-2 py-1.5">
            <div className="h-8 w-8 bg-black rounded-lg flex items-center justify-center text-white">
              <Box className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight leading-tight">CoreQuant</h2>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 custom-scrollbar">

          <div className="space-y-1">
            <p className="px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Main Menu</p>
            <SidebarItem icon={LayoutDashboard} label="Strategies" active />
          </div>

        </div>
      </aside>

      {/* Main Container */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-background md:bg-[#FAFAFA]">

        {/* Header */}
        <header className="h-[76px] bg-white border-b flex items-center justify-between px-6 flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="md:hidden">
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Strategies</h1>
          </div>

          <div className="flex items-center gap-4">
            {isConnected && (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 rounded-full text-xs font-bold border border-green-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Angel One Connected
              </div>
            )}
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-8 custom-scrollbar relative">

          <div className="max-w-[1400px] mx-auto space-y-6">
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

            <div className="w-full animate-in fade-in duration-500 pb-20">
              <StrategyBuilder />
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}

export default App;
