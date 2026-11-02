import { GoogleOAuthProvider } from '@react-oauth/google';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { ApiRequestError } from './api';
import { Btn, Emoji, Empty, FeedbackProvider, Loading } from './components/ui';
import { SessionProvider, applyStoredTheme, useSession } from './context';
import { JoinPage, LoginPage, NickPage, OnboardingPage } from './pages/auth';
import { PendingDebtsPage } from './pages/debts';
import { PlayersPage, RankingPage, StatsPage } from './pages/players';
import { SeasonSessionsPage, SeasonsPage } from './pages/seasons';
import { SessionDebtsPage, SessionPage } from './pages/session';
import { SettingsPage } from './pages/settings';
import './styles.css';

applyStoredTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiRequestError) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 5000,
    },
    mutations: { retry: false },
  },
});

const NAV = [
  { to: '/ranking', icon: '🏆', label: 'Ranking' },
  { to: '/seasons', icon: '🗓️', label: 'Temporadas' },
  { to: '/players', icon: '👥', label: 'Jugadores' },
  { to: '/debts', icon: '💳', label: 'Deudas' },
  { to: '/settings', icon: '⚙️', label: 'Config' },
];

function NavLinks() {
  return (
    <>
      {NAV.map(n => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          <Emoji>{n.icon}</Emoji> {n.label}
        </NavLink>
      ))}
    </>
  );
}

function GroupSwitcher() {
  const { me, group, selectGroup } = useSession();
  const groups = me?.groups ?? [];
  if (groups.length <= 1) {
    return <p className="small muted ellipsis" style={{ padding: '0 12px 12px' }}>{group?.name}</p>;
  }
  return (
    <label className="xs muted" style={{ padding: '0 12px 12px' }}>
      Grupo
      <select value={group?.id} onChange={e => selectGroup(e.target.value)} data-testid="group-switcher">
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
    </label>
  );
}

function Shell() {
  const { me, group, canEdit, loading, loadError, retry } = useSession();
  if (loading) return <Loading />;
  if (loadError) {
    return (
      <Empty icon="⚠️" title="No se pudo conectar">
        <p style={{ margin: '12px 0' }}><Btn variant="ghost" onClick={retry}>Reintentar</Btn></p>
      </Empty>
    );
  }
  if (!me) return <Navigate to="/login" replace />;
  if (!group) return <Navigate to="/onboarding" replace />;
  if (!canEdit && !group.playerId) return <NickPage key={group.id} />;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Principal">
        <div className="brand"><Emoji>♠</Emoji> PokerControl</div>
        <GroupSwitcher />
        <NavLinks />
      </nav>
      {/* Al cambiar de grupo se remonta la página, para no mostrar ids del grupo anterior. */}
      <main className="main" key={group.id}><Outlet /></main>
      <nav className="tabbar" aria-label="Principal móvil"><NavLinks /></nav>
    </div>
  );
}

function PublicOnly({ page }: { page: 'login' | 'onboarding' }) {
  const { me, group, loading } = useSession();
  if (loading) return <Loading />;
  if (page === 'login') return me ? <Navigate to="/ranking" replace /> : <LoginPage />;
  if (!me) return <Navigate to="/login" replace />;
  return group ? <Navigate to="/ranking" replace /> : <OnboardingPage />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<PublicOnly page="login" />} />
        <Route path="/onboarding" element={<PublicOnly page="onboarding" />} />
        <Route path="/join/:code" element={<JoinPage />} />
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/ranking" replace />} />
          <Route path="/seasons" element={<SeasonsPage />} />
          <Route path="/seasons/:seasonId" element={<SeasonSessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionPage />} />
          <Route path="/sessions/:sessionId/debts" element={<SessionDebtsPage />} />
          <Route path="/players" element={<PlayersPage />} />
          <Route path="/players/:playerId/stats" element={<StatsPage />} />
          <Route path="/ranking" element={<RankingPage />} />
          <Route path="/debts" element={<PendingDebtsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Empty icon="🔍" title="Página no encontrada" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''}>
        <FeedbackProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </FeedbackProvider>
      </GoogleOAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
