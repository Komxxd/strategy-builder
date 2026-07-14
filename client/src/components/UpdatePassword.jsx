import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, AlertCircle, Loader2, ShieldCheck, Eye, EyeOff } from 'lucide-react';

export const UpdatePassword = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    // Check if the user actually has a session, otherwise redirect to login
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        navigate('/login');
      }
    });
  }, [navigate]);

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!password) {
      setError("Please enter a new password.");
      return;
    }

    try {
      setLoading(true);
      setError('');
      setMessage('');

      const { error } = await supabase.auth.updateUser({
        password: password
      });

      if (error) throw error;

      setMessage("Password updated successfully! Redirecting...");
      setTimeout(() => {
        navigate('/');
      }, 2000);
    } catch (err) {
      setError(err.message || "Failed to update password. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen w-full bg-[#fafafa] text-foreground font-sans p-6">
      <div className="w-full max-w-md bg-white border p-8 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
        
        <div className="flex flex-col items-center mb-8">
          <div className="h-16 w-16 bg-slate-900 rounded-2xl flex items-center justify-center text-white mb-6 rotate-3 transition-transform hover:rotate-6">
            <Lock className="h-8 w-8" />
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 mb-2">Set New Password</h1>
          <p className="text-slate-500 text-center font-medium">
            Enter a strong new password for your account.
          </p>
        </div>

        <form onSubmit={handleUpdate} className="w-full space-y-5">
          <div className="space-y-4">
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="New Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 border-gray-200 focus:bg-white focus:ring-2 focus:ring-slate-900 focus:border-transparent rounded-xl pl-4 pr-12 transition-all"
                required
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none"
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm font-medium animate-in fade-in bg-red-50 p-3 rounded-xl border border-red-100">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          
          {message && (
            <div className="text-emerald-700 text-sm font-medium animate-in fade-in bg-emerald-50 p-3 rounded-xl border border-emerald-100 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>{message}</span>
            </div>
          )}

          <Button
            type="submit"
            disabled={loading || !password}
            className="w-full h-12 gap-2 text-base font-bold rounded-xl transition-all active:scale-[0.98] bg-slate-900 hover:bg-slate-800 text-white"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-5 w-5" />}
            {loading ? 'Updating...' : 'Update Password'}
          </Button>
        </form>
      </div>
    </div>
  );
};
