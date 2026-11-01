import type { ApiGroupRef, ApiUser } from '@pokercontrol/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, storageGet, storageSet } from './api';

interface Me { user: ApiUser; groups: ApiGroupRef[] }

interface Session {
  me: Me | null;
  loading: boolean;
  /** Reintentable: el servidor no respondió al validar la sesión. */
  loadError: boolean;
  retry: () => void;
  signIn: (token: string) => void;
  signOut: () => void;
  group: ApiGroupRef | null;
  selectGroup: (id: string) => void;
  refreshMe: () => Promise<unknown>;
}

const Ctx = createContext<Session | null>(null);
const GROUP_KEY = 'pc_group';

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setTokenState] = useState(getToken());
  const [groupId, setGroupId] = useState(storageGet(GROUP_KEY));

  const signOut = useCallback(() => {
    setToken(null);
    setTokenState(null);
    qc.clear();
  }, [qc]);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  // Sesión deslizante: cada apertura renueva el JWT de 30 días.
  useEffect(() => {
    if (!token) return;
    api<{ token: string }>('/auth/refresh', { method: 'POST' })
      .then(r => setToken(r.token))
      .catch(() => { /* lo resuelve el handler de 401 o el reintento de /me */ });
  }, [token]);

  const meQuery = useQuery({
    queryKey: ['me', token],
    queryFn: () => api<Me>('/me'),
    enabled: !!token,
    retry: false,
  });
  const me = meQuery.data ?? null;

  const value = useMemo<Session>(() => {
    const groups = me?.groups ?? [];
    return {
      me,
      loading: !!token && meQuery.isLoading,
      loadError: !!token && meQuery.isError,
      retry: () => { void meQuery.refetch(); },
      signIn: t => { setToken(t); setTokenState(t); },
      signOut,
      group: groups.find(g => g.id === groupId) ?? groups[0] ?? null,
      selectGroup: id => { storageSet(GROUP_KEY, id); setGroupId(id); },
      refreshMe: () => meQuery.refetch(),
    };
  }, [me, token, meQuery, signOut, groupId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const value = useContext(Ctx);
  if (!value) throw new Error('Falta SessionProvider');
  return value;
}

/** Grupo activo; solo se usa dentro de rutas que ya exigen tener uno. */
export function useGroup() {
  const { group } = useSession();
  if (!group) throw new Error('Sin grupo activo');
  const qc = useQueryClient();
  return {
    group,
    path: (rest: string) => `/groups/${group.id}${rest}`,
    key: (...parts: unknown[]) => [group.id, ...parts],
    invalidate: () => qc.invalidateQueries({ queryKey: [group.id] }),
  };
}

// ─── Tema ────────────────────────────────────────────────────────────────────
export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'pc_theme';

export function applyStoredTheme(): void {
  const theme = storageGet(THEME_KEY);
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>((storageGet(THEME_KEY) as Theme) || 'system');
  return [theme, t => {
    setTheme(t);
    storageSet(THEME_KEY, t === 'system' ? null : t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }];
}
