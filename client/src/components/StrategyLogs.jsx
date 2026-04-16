import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Clock, X, Info, Flame, AlertCircle } from 'lucide-react';

export function StrategyLogs({ isOpen, onClose, logs, strategyName }) {
    const scrollRef = useRef(null);

    useEffect(() => {
        if (isOpen && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, isOpen]);

    // Prevent background scrolling when modal is open
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = 'unset';
        }
        return () => { document.body.style.overflow = 'unset'; };
    }, [isOpen]);

    if (!isOpen) return null;

    const getLevelConfig = (level) => {
        switch (level) {
            case 'CRITICAL':
                return { color: 'text-orange-500', icon: <Flame className="h-3 w-3" /> };
            case 'ERROR':
                return { color: 'text-red-500', icon: <AlertCircle className="h-3 w-3" /> };
            default:
                return { color: 'text-blue-500', icon: <Info className="h-3 w-3" /> };
        }
    };

    const modalContent = (
        <div
            className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[4px] transition-all duration-500 ease-in-out animate-in fade-in"
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="bg-white w-full max-w-xl h-[550px] flex flex-col rounded-xl shadow-[0_20px_40px_-12px_rgba(0,0,0,0.2)] border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-8 duration-500 fill-mode-forwards ease-out">
                {/* Compact Header */}
                <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
                    <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 bg-slate-900 rounded-lg flex items-center justify-center shadow-lg shadow-slate-200">
                            <MessageSquare className="h-4 w-4 text-white" />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-900 tracking-tight leading-none">Execution Logs</h3>
                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1 opacity-70">
                                {strategyName}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-slate-100 transition-all text-slate-400 hover:text-slate-900"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Dense Log Feed */}
                <div className="flex-1 overflow-hidden bg-slate-50/30">
                    <div
                        ref={scrollRef}
                        className="h-full overflow-y-auto px-4 py-3 custom-scrollbar scroll-smooth"
                    >
                        <div className="space-y-0.5">
                            {logs && logs.length > 0 ? (
                                logs.map((log, i) => {
                                    const config = getLevelConfig(log.level);
                                    return (
                                        <div key={i} className="group flex items-start gap-2.5 py-1 px-2.5 rounded hover:bg-white hover:shadow-sm border border-transparent hover:border-slate-100 transition-all duration-200">
                                            {/* Time Column */}
                                            <div className="shrink-0 w-20 pt-0.5">
                                                <span className="text-[10px] font-bold text-black font-mono tracking-tighter block whitespace-nowrap opacity-100">
                                                    {log.status_time || (log.time.includes(' at ') ? log.time.split(' at ')[1] : log.time.slice(11, 19))}
                                                </span>
                                            </div>

                                            {/* Level Icon */}
                                            <div className="shrink-0 pt-1">
                                                <div className={`${config.color}`}>{config.icon}</div>
                                            </div>

                                            {/* Message Body */}
                                            <div className="flex-1">
                                                <p className="text-[12px] font-semibold text-slate-700 leading-tight">
                                                    {log.message}
                                                    {log.level !== 'INFO' && (
                                                        <span className={`ml-2 text-[9px] font-black uppercase tracking-tighter ${config.color} bg-slate-50 px-1.5 py-0.5 rounded`}>
                                                            {log.level}
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                        </div>
                                    );
                                })
                            ) : (
                                <div className="h-full flex flex-col items-center justify-center py-20 opacity-20">
                                    <Clock className="h-10 w-10 text-slate-300 mb-3" />
                                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">No Logs Available</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Compact Footer */}
                <div className="px-4 py-2 bg-white border-t border-slate-100 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2 text-[8px] font-bold text-slate-400 uppercase tracking-widest">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Live Monitoring
                    </div>
                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-100">
                        {logs?.length || 0} Total Events
                    </div>
                </div>

                <style dangerouslySetInnerHTML={{
                    __html: `
                    .custom-scrollbar::-webkit-scrollbar {
                        width: 4px;
                    }
                    .custom-scrollbar::-webkit-scrollbar-track {
                        background: transparent;
                    }
                    .custom-scrollbar::-webkit-scrollbar-thumb {
                        background: #e2e8f0;
                        border-radius: 10px;
                    }
                    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                        background: #cbd5e1;
                    }
                    @keyframes fade-in { 
                        from { opacity: 0; } 
                        to { opacity: 1; } 
                    }
                    @keyframes zoom-in-95 { 
                        from { transform: scale(0.95) translateY(10px); opacity: 0; } 
                        to { transform: scale(1) translateY(0); opacity: 1; } 
                    }
                    @keyframes slide-in-bottom { 
                        from { transform: translateY(2rem); opacity: 0; } 
                        to { transform: translateY(0); opacity: 1; } 
                    }
                    .animate-in { 
                        animation-duration: 400ms; 
                        animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); 
                        animation-fill-mode: forwards; 
                    }
                    .fade-in { animation-name: fade-in; }
                    .zoom-in-95 { animation-name: zoom-in-95; }
                    .slide-in-from-bottom-8 { animation-name: slide-in-bottom; }
                `}} />
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}
