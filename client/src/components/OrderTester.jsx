import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { executeOrderAction } from '@/api';

const DEFAULT_PAYLOADS = {
    placeOrder: {
        variety: "NORMAL",
        tradingsymbol: "SBIN-EQ",
        symboltoken: "3045",
        transactiontype: "BUY",
        exchange: "NSE",
        ordertype: "MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        price: "0",
        squareoff: "0",
        stoploss: "0",
        quantity: "1",
        scripconsent: "yes"
    },
    modifyOrder: {
        variety: "NORMAL",
        orderid: "201020000000080",
        ordertype: "LIMIT",
        producttype: "INTRADAY",
        duration: "DAY",
        price: "194.00",
        quantity: "1",
        tradingsymbol: "SBIN-EQ",
        symboltoken: "3045",
        exchange: "NSE"
    },
    cancelOrder: {
        variety: "NORMAL",
        orderid: "201020000000080"
    },
    getOrderBook: null,
    getTradeBook: null,
    marketData: {
        mode: "LTP",
        exchangeTokens: {
            NSE: ["3045"]
        }
    },
    indOrderDetails: {
        uniqueorderid: "05ebf91b-bea4-4a1d-b0f2-4259606570e3"
    }
};

export function OrderTester() {
    const [action, setAction] = useState("placeOrder");
    const [payloadText, setPayloadText] = useState(JSON.stringify(DEFAULT_PAYLOADS.placeOrder, null, 2));
    const [responseText, setResponseText] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const handleActionChange = (value) => {
        setAction(value);
        const nextPayload = DEFAULT_PAYLOADS[value];
        if (nextPayload === null) {
            setPayloadText("");
        } else {
            setPayloadText(JSON.stringify(nextPayload, null, 2));
        }
    };

    const handleRun = async () => {
        setError("");
        setResponseText("");
        setLoading(true);
        try {
            let payload = null;
            if (payloadText && payloadText.trim().length > 0) {
                payload = JSON.parse(payloadText);
            }
            const res = await executeOrderAction({ action, payload });
            setResponseText(JSON.stringify(res, null, 2));
        } catch (err) {
            setError(err.message || "Failed to execute order action");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Card className="w-full border-border bg-card">
            <CardHeader className="border-b">
                <CardTitle className="text-lg font-bold">Order Test Console</CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
                <div className="flex flex-col md:flex-row gap-4 items-start md:items-end">
                    <div className="w-full md:w-64 space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Action</label>
                        <Select value={action} onValueChange={handleActionChange}>
                            <SelectTrigger className="h-11 rounded-xl">
                                <SelectValue placeholder="Select Action" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="placeOrder">Place Order</SelectItem>
                                <SelectItem value="modifyOrder">Modify Order</SelectItem>
                                <SelectItem value="cancelOrder">Cancel Order</SelectItem>
                                <SelectItem value="getOrderBook">Get Order Book</SelectItem>
                                <SelectItem value="getTradeBook">Get Trade Book</SelectItem>
                                <SelectItem value="marketData">Get LTP (Market Data)</SelectItem>
                                <SelectItem value="indOrderDetails">Order Details</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <Button className="h-11 px-6 rounded-xl" onClick={handleRun} disabled={loading}>
                        {loading ? "Running..." : "Run"}
                    </Button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Payload (JSON)</label>
                        <textarea
                            className="w-full h-72 rounded-xl border border-input bg-background p-3 text-xs font-mono"
                            value={payloadText}
                            onChange={(e) => setPayloadText(e.target.value)}
                            placeholder='{}'
                        />
                        <p className="text-[10px] text-muted-foreground italic">
                            Leave empty for actions like Order Book and Trade Book.
                        </p>
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Response</label>
                        <textarea
                            className="w-full h-72 rounded-xl border border-input bg-muted/40 p-3 text-xs font-mono"
                            value={error ? error : responseText}
                            readOnly
                        />
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
