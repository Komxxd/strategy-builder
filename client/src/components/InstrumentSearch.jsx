import React, { useState, useEffect } from 'react';
import { searchInstruments } from '@/api';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Search } from 'lucide-react';

export function InstrumentSearch({ onSelect }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const timer = setTimeout(async () => {
            if (query.length > 1) {
                setLoading(true);
                try {
                    const res = await searchInstruments({ query });
                    if (res.success) {
                        setResults(res.data);
                    }
                } catch (err) {
                    console.error(err);
                } finally {
                    setLoading(false);
                }
            } else {
                setResults([]);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [query]);

    return (
        <div className="relative w-full max-w-md">
            <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                    placeholder="Search instruments (e.g. NIFTY, RELIANCE)"
                    className="pl-8"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
            </div>
            {results.length > 0 && (
                <Card className="absolute z-50 mt-1 w-full shadow-2xl max-h-64 overflow-y-auto bg-white border-2 opacity-100">
                    <CardContent className="p-0 bg-white">
                        {results.map((inst) => (
                            <div
                                key={inst.token}
                                className="flex items-center justify-between p-3 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-0"
                                onClick={() => {
                                    onSelect(inst);
                                    setQuery('');
                                    setResults([]);
                                }}
                            >
                                <div>
                                    <div className="font-bold text-sm text-slate-900">{inst.symbol}</div>
                                    <div className="text-xs text-slate-500">{inst.name}</div>
                                </div>
                                <div className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 font-bold border border-slate-200">
                                    {inst.exch_seg}
                                </div>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
