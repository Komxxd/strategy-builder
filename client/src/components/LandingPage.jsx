import React from 'react';
import { Button } from "@/components/ui/button";
import { ArrowRight, BarChart2, Zap, Shield, TrendingUp, Box } from 'lucide-react';

import { useNavigate } from 'react-router-dom';

export function LandingPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-[#fafafa] text-foreground font-sans selection:bg-primary/20">
      
      {/* Navigation */}
      <nav className="fixed top-0 left-0 w-full px-6 py-6 flex items-center justify-between z-50">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 bg-black rounded-lg flex items-center justify-center text-white">
            <Box className="h-5 w-5" />
          </div>
          <span className="text-xl font-bold tracking-tight">CoreQuant</span>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="ghost" className="font-semibold" onClick={() => navigate('/login')}>
            Log in
          </Button>
          <Button className="font-semibold rounded-xl" onClick={() => navigate('/register')}>
            Sign up <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden flex flex-col items-center justify-center min-h-[90vh]">
        {/* Abstract Background Shapes */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl opacity-50 -z-10 animate-pulse"></div>
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-500/10 rounded-full blur-3xl opacity-50 -z-10"></div>
        <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-purple-500/10 rounded-full blur-3xl opacity-50 -z-10"></div>

        <div className="container mx-auto px-6 text-center z-10 relative">

          
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-8 max-w-4xl mx-auto leading-[1.1] animate-in slide-in-from-bottom-6 duration-700 delay-100">
            Build, Test, and Deploy <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-primary">Winning Strategies</span>
          </h1>
          

          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-in slide-in-from-bottom-10 duration-700 delay-300">

            <Button size="lg" variant="outline" className="h-14 px-8 text-lg font-bold rounded-xl bg-white/50 backdrop-blur-md border-gray-200 hover:bg-gray-50 transition-all" onClick={() => navigate('/login')}>
              Log in to Dashboard
            </Button>
          </div>
        </div>

      </main>
    </div>
  );
}
