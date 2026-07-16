import React, { useState, useEffect } from 'react';
import { User, Mail, ShieldCheck, Pencil, Check, X, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

export const Profile = () => {
  const [user, setUser] = useState(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUser(user);
      }
    });
  }, []);

  const handleSaveName = async () => {
    if (!newName.trim() || newName.trim() === fullName) {
      setIsEditingName(false);
      return;
    }
    try {
      setIsSaving(true);
      const { data, error } = await supabase.auth.updateUser({
        data: { full_name: newName.trim() }
      });
      if (error) throw error;
      if (data?.user) {
        setUser(data.user);
      }
      setIsEditingName(false);
    } catch (err) {
      console.error("Error updating name:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const getFallbackName = (email) => {
    if (!email) return 'Trader';
    const namePart = email.split('@')[0];
    return namePart
      .split(/[._-]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  };

  const email = user?.email || '';
  const fullName = user?.user_metadata?.full_name || user?.user_metadata?.name || getFallbackName(email);

  return (
    <div className="w-full h-full flex flex-col items-center p-4 sm:p-8 md:p-12 animate-in fade-in duration-500">
      
      <div className="bg-white border p-6 sm:p-8 rounded-2xl w-full max-w-md flex flex-col items-center">
        <div className="bg-slate-100 h-16 w-16 sm:h-20 sm:w-20 flex items-center justify-center rounded-full mb-4 sm:mb-6">
          <span className="text-2xl sm:text-3xl font-bold text-slate-400">
            {fullName ? fullName.charAt(0).toUpperCase() : 'U'}
          </span>
        </div>
        
        {isEditingName ? (
          <div className="flex items-center gap-2 mb-2 w-full max-w-sm">
            <input 
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 w-full bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg text-base sm:text-lg font-bold text-slate-900 outline-none focus:border-primary/50"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') setIsEditingName(false);
              }}
            />
            <button 
              onClick={handleSaveName} 
              disabled={isSaving}
              className="p-2 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
            <button 
              onClick={() => setIsEditingName(false)} 
              disabled={isSaving}
              className="p-2 bg-slate-50 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-1 group max-w-full">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">{fullName}</h2>
            <button 
              onClick={() => {
                setNewName(fullName);
                setIsEditingName(true);
              }}
              className="p-1.5 shrink-0 text-slate-400 transition-colors hover:text-slate-900 hover:bg-slate-50 rounded-lg"
              title="Edit Name"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        )}
        
        <div className="flex items-center gap-2 text-slate-500 mb-6 font-medium text-sm">
          <Mail className="h-4 w-4" />
          <span>{email || 'Loading email...'}</span>
        </div>

        <div className="w-full h-px bg-slate-100 my-4"></div>

        <div className="w-full flex items-center justify-between p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <div className="flex flex-col">
              <span className="text-sm font-bold text-emerald-900">Account Status</span>
              <span className="text-[11px] font-medium text-emerald-700">Active and Verified</span>
            </div>
          </div>
        </div>
        
      </div>
    </div>
  );
};
