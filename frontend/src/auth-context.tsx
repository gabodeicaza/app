import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { storage } from '@/src/utils/storage';
import { api } from '@/src/api';

export type Role =
  | 'coordinador'         // alias legacy de supervisor_general
  | 'especialista'
  | 'supervisor_t1'
  | 'supervisor_t2'
  | 'supervisor_general'
  | 'contratista'
  | 'dependencia';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  area?: string | null;
  puesto?: string | null;
}

interface Ctx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me);
      await storage.setItem('syncsite_user', JSON.stringify(me));
    } catch {
      setUser(null);
      await storage.secureRemove('syncsite_token');
      await storage.removeItem('syncsite_user');
    }
  }, []);

  useEffect(() => {
    (async () => {
      const cached = await storage.getItem<string>('syncsite_user', '');
      if (cached) {
        try { setUser(JSON.parse(cached)); } catch {}
      }
      const tok = await storage.secureGet<string>('syncsite_token', '');
      if (tok) await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: u } = await api.login(email, password);
    await storage.secureSet('syncsite_token', token);
    await storage.setItem('syncsite_user', JSON.stringify(u));
    setUser(u);
    return u as User;
  }, []);

  const logout = useCallback(async () => {
    await storage.secureRemove('syncsite_token');
    await storage.removeItem('syncsite_user');
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout, refresh }), [user, loading, login, logout, refresh]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth fuera de AuthProvider');
  return ctx;
}
