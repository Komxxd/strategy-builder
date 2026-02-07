import React, { useEffect, useState } from 'react';
import { initSocket, subscribeToTokens } from '@/api';
import { EXCHANGE_TYPE_MAP } from '@/lib/utils';

export function LivePrice({ instrument, onPriceUpdate }) {
    const [price, setPrice] = useState(null);

    useEffect(() => {
        if (!instrument) return;

        const socket = initSocket();
        const exchangeType = EXCHANGE_TYPE_MAP[instrument.exch_seg] || 1;

        subscribeToTokens({
            exchangeType,
            tokens: [instrument.token]
        });

        const handleTick = (data) => {
            const token = String(data.token || '').replace(/"/g, '');
            if (token === instrument.token) {
                const rawPrice = data.last_traded_price || data.ltp;
                if (rawPrice) {
                    const newPrice = Number(rawPrice) / 100;
                    setPrice(newPrice);
                    if (onPriceUpdate) onPriceUpdate(newPrice);
                }
            }
        };

        socket.on('tick', handleTick);

        return () => {
            socket.off('tick', handleTick);
        };
    }, [instrument]);

    if (!instrument) return null;

    return (
        <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{instrument.symbol}:</span>
            <span className="text-lg font-mono font-bold text-primary">
                {price ? price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '---'}
            </span>
        </div>
    );
}
