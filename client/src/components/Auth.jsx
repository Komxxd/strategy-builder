import React, { useState } from'react';
import { Button } from"@/components/ui/button";
import { Input } from"@/components/ui/input";
import { Lock, LogIn, UserPlus, AlertCircle, Loader2, Box, ShieldCheck, Eye, EyeOff, Mail } from 'lucide-react';
import { supabase } from'../lib/supabase';

import { useNavigate } from'react-router-dom';

export function Auth({ onAuthenticated, defaultView ='login' }) {
 const navigate = useNavigate();
  const isLogin = defaultView === 'login';
  const [viewState, setViewState] = useState(defaultView); // 'login', 'register', 'forgot'
  const [email, setEmail] = useState('');
 const [password, setPassword] = useState('');
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 const [message, setMessage] = useState('');
 const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');

    try {
      if (viewState === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/update-password`,
        });
        if (error) throw error;
        setMessage("Password reset link sent! Check your email.");
      } else if (viewState === 'login') {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        
        if (error) throw error;
        if (data.session) {
          onAuthenticated();
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });
        
        if (error) throw error;
        setMessage('Check your email for the login link or verify your account!');
        // Auto-login logic if email confirmation is disabled in Supabase
        if (data.session) {
          onAuthenticated();
        }
      }
    } catch (err) {
      setError(err.message || "Authentication failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

 return (
 <div className="flex flex-col items-center justify-center min-h-screen w-full bg-[#fafafa] text-foreground font-sans">
 {/* Navigation */}
 <nav className="fixed top-0 left-0 w-full px-6 py-6 flex items-center justify-between z-50">
 <div 
 className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity" 
 onClick={() => navigate('/')}
 >
 <div className="h-8 w-8 bg-black rounded-lg flex items-center justify-center text-white">
 <Box className="h-5 w-5" />
 </div>
 <span className="text-xl font-bold tracking-tight">CoreQuant</span>
 </div>
 </nav>
 
 <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 w-full max-w-md bg-white p-8 sm:p-10 rounded-3xl border border-gray-200 flex flex-col items-center gap-6 mx-4">
 <div className="h-16 w-16 bg-slate-900 rounded-2xl flex items-center justify-center text-white">
 <Lock className="h-8 w-8" />
 </div>

 <div className="text-center space-y-2 mb-2">
          <h1 className="text-3xl font-black tracking-tight text-slate-900 mb-2">
            {viewState === 'forgot' ? 'Reset Password' : (viewState === 'login' ? 'Welcome Back' : 'Create Account')}
          </h1>
          <p className="text-slate-500 text-center font-medium">
            {viewState === 'forgot' ? 'Enter your email to receive a recovery link' : (viewState === 'login' ? 'Enter your credentials to access CoreQuant' : 'Sign up to start building strategies')}
          </p>
 </div>

 <form onSubmit={handleSubmit} className="w-full space-y-5">
 <div className="space-y-4">
            <Input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 border-gray-200 focus:bg-white focus:ring-2 focus:ring-slate-900 focus:border-transparent rounded-xl px-4 transition-all"
              autoFocus
              required
            />
            {viewState !== 'forgot' && (
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 border-gray-200 focus:bg-white focus:ring-2 focus:ring-slate-900 focus:border-transparent rounded-xl pl-4 pr-12 transition-all"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            )}
            
            {viewState === 'login' && (
              <div className="flex justify-end mt-1">
                <button 
                  type="button" 
                  onClick={() => { setError(''); setMessage(''); setViewState('forgot'); }} 
                  className="text-sm font-semibold text-slate-500 hover:text-slate-900 transition-colors"
                >
                  Forgot password?
                </button>
              </div>
            )}
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
            disabled={loading || !email || (viewState !== 'forgot' && !password)}
            className="w-full h-12 gap-2 text-base font-bold rounded-xl transition-all active:scale-[0.98] bg-slate-900 hover:bg-slate-800 text-white"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (viewState === 'forgot' ? <Mail className="h-5 w-5" /> : (viewState === 'login' ? <LogIn className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />))}
            {loading ? 'Processing...' : (viewState === 'forgot' ? 'Send Reset Link' : (viewState === 'login' ? 'Sign In' : 'Create Account'))}
          </Button>
        </form>
        
        <div className="mt-6 text-sm text-center text-muted-foreground">
          {viewState === 'forgot' ? (
            <button 
              type="button"
              onClick={() => { setError(''); setMessage(''); setViewState('login'); }}
              className="font-bold text-slate-900 hover:underline transition-colors"
            >
              Back to Login
            </button>
          ) : (
            <>
              {viewState === 'login' ? "Don't have an account? " : "Already have an account? "}
              <button 
                type="button"
                onClick={() => {
                  setError('');
                  setMessage('');
                  if (viewState === 'login') {
                    navigate('/register');
                    setViewState('register');
                  } else {
                    navigate('/login');
                    setViewState('login');
                  }
                }}
                className="font-bold text-slate-900 hover:underline transition-colors"
              >
                {viewState === 'login' ? 'Sign Up' : 'Sign In'}
              </button>
            </>
          )}
        </div>
 </div>
 </div>
 );
}
