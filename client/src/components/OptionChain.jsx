import React, { useState, useEffect, useRef } from 'react';
import { getOptionChain, initSocket, subscribeToTokens } from '@/api';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EXCHANGE_TYPE_MAP } from '@/lib/utils';


export function OptionChain({ symbol, exchange = "NFO", spotPrice }) {
    const [data, setData] = useState(null);
    const [expiry, setExpiry] = useState(null);
    const [prices, setPrices] = useState({});
    const [loading, setLoading] = useState(false);
    const atmRef = useRef(null);
    const hasScrolled = useRef(false);

    // Calculate ATM Strike
    const atmStrike = data?.chain?.length > 0 && spotPrice ? data.chain.reduce((prev, curr) => {
        return (Math.abs(curr.strike - spotPrice) < Math.abs(prev.strike - spotPrice) ? curr : prev);
    }).strike : null;

    useEffect(() => {
        if (!symbol) return;

        async function fetchData() {
            setLoading(true);
            try {
                const res = await getOptionChain({ symbol, exchange, expiry });
                if (res.success) {
                    setData(res.data);
                    if (!expiry) setExpiry(res.data.expiry);

                    const tokens = [];
                    res.data.chain.forEach(row => {
                        if (row.CE) tokens.push(row.CE.token);
                        if (row.PE) tokens.push(row.PE.token);
                    });

                    if (tokens.length > 0) {
                        const exchangeType = EXCHANGE_TYPE_MAP[exchange] || 2;
                        subscribeToTokens({ exchangeType, tokens });
                    }
                }
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
        hasScrolled.current = false;
    }, [symbol, expiry, exchange]);

    // Auto-scroll to ATM
    useEffect(() => {
        if (!loading && data?.chain && atmStrike && atmRef.current && !hasScrolled.current) {
            setTimeout(() => {
                atmRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
                hasScrolled.current = true;
            }, 500);
        }
    }, [loading, data, atmStrike]);

    useEffect(() => {
        const socket = initSocket();
        const handleTick = (tick) => {
            const token = String(tick.token || '').replace(/"/g, '');
            const rawPrice = tick.last_traded_price || tick.ltp;
            if (token && rawPrice) {
                setPrices(prev => ({ ...prev, [token]: Number(rawPrice) / 100 }));
            }
        };

        socket.on('tick', handleTick);
        return () => socket.off('tick', handleTick);
    }, []);

    if (!symbol) return null;

    return (
        <Card className="w-full mt-6">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                <CardTitle className="text-lg font-bold">Option Chain: {symbol}</CardTitle>
                {data?.expiries && (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground font-medium">Expiry:</span>
                        <select
                            value={expiry || ""}
                            onChange={(e) => setExpiry(e.target.value)}
                            className="text-xs border rounded p-1 bg-background"
                        >
                            {data.expiries.map(exp => (
                                <option key={exp} value={exp}>{exp}</option>
                            ))}
                        </select>
                    </div>
                )}
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="flex justify-center p-8 text-sm text-muted-foreground animate-pulse">Loading chain...</div>
                ) : (
                    <Table containerClassName="max-h-[500px] border rounded-md shadow-inner">
                        <TableHeader className="sticky top-0 z-30 bg-white shadow-sm">
                            <TableRow className="bg-white hover:bg-white border-b-2">
                                <TableHead className="text-center font-bold text-emerald-600 h-12 bg-white border-b-2 opacity-100">CALL LTP</TableHead>
                                <TableHead className="text-center font-bold bg-slate-50 h-12 border-x border-b-2 opacity-100">STRIKE</TableHead>
                                <TableHead className="text-center font-bold text-red-600 h-12 bg-white border-b-2 opacity-100">PUT LTP</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {data?.chain.map((row, index) => {
                                const atmIndex = data.chain.findIndex(r => r.strike === atmStrike);
                                const isATM = row.strike === atmStrike;
                                const distance = atmIndex !== -1 ? Math.abs(index - atmIndex) : 0;

                                const callLabel = isATM ? "ATM" : (atmIndex !== -1 && index < atmIndex ? `ITM${distance}` : `OTM${distance}`);
                                const putLabel = isATM ? "ATM" : (atmIndex !== -1 && index > atmIndex ? `ITM${distance}` : `OTM${distance}`);

                                const isCallITM = atmIndex !== -1 && index < atmIndex;
                                const isPutITM = atmIndex !== -1 && index > atmIndex;

                                return (
                                    <TableRow
                                        key={row.strike}
                                        className={isATM ? "bg-slate-50 hover:bg-slate-100" : ""}
                                        ref={isATM ? atmRef : null}
                                    >
                                        <TableCell className={`text-center font-mono font-medium relative ${isCallITM ? "bg-emerald-50" : ""}`}>
                                            <div className="flex flex-col items-center">
                                                {prices[row.CE?.token] ? (
                                                    <span className="text-emerald-500">{prices[row.CE.token].toFixed(2)}</span>
                                                ) : (
                                                    <span className="text-muted-foreground">---</span>
                                                )}
                                                {!isATM && (
                                                    <span className={`text-[10px] font-bold ${isCallITM ? 'text-emerald-300' : 'text-slate-400'}`}>
                                                        {callLabel}
                                                    </span>
                                                )}
                                            </div>
                                        </TableCell>
                                        <TableCell className={`text-center font-bold ${isATM ? "bg-slate-100 text-primary" : "bg-slate-50 text-slate-500"}`}>
                                            <div className="flex flex-col items-center">
                                                {row.strike}
                                                {isATM && <span className="text-[10px] font-black uppercase tracking-tighter">ATM</span>}
                                            </div>
                                        </TableCell>
                                        <TableCell className={`text-center font-mono font-medium relative ${isPutITM ? "bg-red-50" : ""}`}>
                                            <div className="flex flex-col items-center">
                                                {prices[row.PE?.token] ? (
                                                    <span className="text-red-500">{prices[row.PE.token].toFixed(2)}</span>
                                                ) : (
                                                    <span className="text-muted-foreground">---</span>
                                                )}
                                                {!isATM && (
                                                    <span className={`text-[10px] font-bold ${isPutITM ? 'text-red-300' : 'text-slate-400'}`}>
                                                        {putLabel}
                                                    </span>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}
