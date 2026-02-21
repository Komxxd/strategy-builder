import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StrategyBuilder } from './components/StrategyBuilder';
import { BrokerConnect } from './components/BrokerConnect';
import { StrategyHistory } from './components/StrategyHistory';
import { supabase } from './lib/supabase';
import { Auth } from './components/Auth';
import { LandingPage } from './components/LandingPage';
import { LayoutDashboard, Power, Cpu, TrendingUp, AlertCircle, CheckCircle2, LogOut, History } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
function App() {
  const [session, setSession] = useState(null);
  const [showAuth, setShowAuth] = useState(false);
  const [selectedInstrument, setSelectedInstrument] = useState(null);
  const [spotPrice, setSpotPrice] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) {
      import('./api').then(({ initSocket }) => {
        const socket = initSocket();

        const handleBrokerStatus = (data) => {
          setIsConnected(data.connected);
          if (!data.connected) {
            // Will silently set false if server restarts, causing UI to show connection screen
            console.log("Broker disconnected or server restarted.");
          }
        };

        socket.on('broker_status', handleBrokerStatus);

        return () => {
          socket.off('broker_status', handleBrokerStatus);
        };
      });
    }
  }, [session]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setIsConnected(false);
  };

  if (!session) {
    return showAuth ? (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-6xl mx-auto">
          <header className="flex items-center justify-between border-b pb-6 mb-8">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setShowAuth(false)}>
              <TrendingUp className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold tracking-tight">StrategyBuilder</h1>
            </div>
            <Button variant="ghost" onClick={() => setShowAuth(false)}>Back to Home</Button>
          </header>
          <Auth />
        </div>
      </div>
    ) : (
      <LandingPage onGetStarted={() => setShowAuth(true)} />
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between border-b pb-6">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Strategy Builder</h1>
          </div>
          <div className="flex items-center gap-4">
            {isConnected && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-green-100 text-green-700 rounded-full text-xs font-semibold border border-green-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Angel One Active
              </div>
            )}
            <Button
              variant="outline"
              size="icon"
              className="rounded-full"
              onClick={handleLogout}
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

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

        {!isConnected ? (
          <div className="py-12">
            <BrokerConnect onConnected={() => {
              setIsConnected(true);
              setSuccess("Successfully connected to the live market!");
            }} />
          </div>
        ) : (
          <Tabs defaultValue="execution" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="execution" className="gap-2">
                <Cpu className="h-4 w-4" /> Execution
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-2">
                <History className="h-4 w-4" /> History
              </TabsTrigger>
            </TabsList>



            <TabsContent value="execution" className="animate-in fade-in duration-500">
              <StrategyBuilder userId={session?.user?.id} />
            </TabsContent>

            <TabsContent value="history" className="animate-in fade-in duration-500">
              <StrategyHistory userId={session?.user?.id} />
            </TabsContent>


          </Tabs>
        )}
      </div>
    </div>
  );
}

export default App;
