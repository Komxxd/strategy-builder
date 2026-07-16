import React, { useEffect, useState } from'react';
import { useNavigate, useSearchParams } from'react-router-dom';
import { Loader2, CheckCircle2, AlertCircle } from'lucide-react';
import { verifyBrokerCallback } from'../api';

export function BrokerCallback() {
 const [searchParams] = useSearchParams();
 const navigate = useNavigate();
 const [status, setStatus] = useState('processing'); // processing, success, error
 const [message, setMessage] = useState('Connecting to Angel One...');

 useEffect(() => {
 const authToken = searchParams.get('auth_token');
 
 if (!authToken) {
 setStatus('error');
 setMessage('Authentication failed: No auth token received from Angel One.');
 setTimeout(() => navigate('/?tab=broker'), 3000);
 return;
 }

 const verifyToken = async () => {
 try {
 const data = await verifyBrokerCallback(authToken);
 if (data.success) {
 setStatus('success');
 setMessage('Broker connected successfully! Redirecting...');
 setTimeout(() => {
 window.location.href = '/?tab=broker';
 }, 2000);
 } else {
 setStatus('error');
 setMessage(data.message ||'Failed to verify broker connection.');
 setTimeout(() => window.location.href = '/?tab=broker', 3000);
 }
 } catch (err) {
 setStatus('error');
 setMessage(err.message ||'Server error during broker verification.');
 setTimeout(() => navigate('/'), 3000);
 }
 };

 verifyToken();
 }, [searchParams, navigate]);

 return (
 <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
 <div className="bg-white p-8 rounded-2xl border max-w-md w-full text-center space-y-4">
 {status ==='processing' && (
 <>
 <div className="mx-auto w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mb-4">
 <Loader2 className="h-6 w-6 text-blue-600 animate-spin" />
 </div>
 <h2 className="text-xl font-bold">Authenticating...</h2>
 <p className="text-muted-foreground">{message}</p>
 </>
 )}

 {status ==='success' && (
 <>
 <div className="mx-auto w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mb-4">
 <CheckCircle2 className="h-6 w-6 text-emerald-600" />
 </div>
 <h2 className="text-xl font-bold text-emerald-700">Success!</h2>
 <p className="text-muted-foreground">{message}</p>
 </>
 )}

 {status ==='error' && (
 <>
 <div className="mx-auto w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mb-4">
 <AlertCircle className="h-6 w-6 text-red-600" />
 </div>
 <h2 className="text-xl font-bold text-red-700">Authentication Failed</h2>
 <p className="text-muted-foreground">{message}</p>
 </>
 )}
 </div>
 </div>
 );
}
