import React from 'react';
import { Button } from "@/components/ui/button";
import { TrendingUp, ArrowRight } from 'lucide-react';

export function LandingPage({ onGetStarted }) {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-6 overflow-hidden relative">
            {/* Background Decorative Elements removed */}

            <div className="max-w-md w-full space-y-10 text-center animate-in fade-in slide-in-from-bottom-8 duration-1000">
                <div className="flex flex-col items-center gap-4">
                    <div className="p-4 bg-muted rounded-2xl animate-float">
                        <TrendingUp className="h-12 w-12 text-primary" />
                    </div>
                    <h1 className="text-4xl font-black tracking-tight tracking-tighter">
                        StrategyBuilder
                    </h1>
                </div>

                <div className="space-y-4">
                    <p className="text-muted-foreground text-lg leading-relaxed">
                        The premium algo trading terminal for Angel One.
                    </p>

                    <Button
                        size="lg"
                        className="h-16 px-10 text-xl font-bold gap-3 rounded-2xl shadow-xl hover:shadow-2xl hover:bg-primary transition-all active:scale-95 group"
                        onClick={onGetStarted}
                    >
                        Get Started <ArrowRight className="h-6 w-6 group-hover:translate-x-1 transition-transform" />
                    </Button>
                </div>
            </div>

            <footer className="absolute bottom-10 text-xs text-muted-foreground">
                © 2026 StrategyBuilder. All rights reserved.
            </footer>
        </div>
    );
}
