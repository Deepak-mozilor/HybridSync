import { useEffect, useState } from 'react';
import GodView    from './views/GodView';
import SquadView  from './views/SquadView';
import LoginPage  from './views/LoginPage';
import { syncTeams, recalculateDeps } from './api';

function loadTheme() {
  const stored = localStorage.getItem('hs_theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const TABS = [
  { id: 'god',   label: 'Admin View',         icon: '🏢', roles: ['admin'] },
  { id: 'squad', label: 'Manager Squad View', icon: '👥', roles: ['admin', 'manager'] },
];

function loadStoredAuth() {
  // Check URL params first — set by Slack OAuth callback redirect
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  const role   = params.get('role');
  const name   = params.get('name');
  const teamId = params.get('teamId') || undefined;
  const authError = params.get('auth_error');

  if (authError) {
    window.history.replaceState({}, '', '/');
    return { error: authError === 'unauthorized' ? 'You are not authorised to access this dashboard.' : 'Login failed. Please try again.' };
  }

  if (token && role) {
    localStorage.setItem('hs_token', token);
    localStorage.setItem('hs_auth', JSON.stringify({ role, teamId, name }));
    window.history.replaceState({}, '', '/'); // remove token from URL
    return { role, teamId, name };
  }

  try {
    const raw = localStorage.getItem('hs_auth');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export default function App() {
  const [auth,      setAuth]      = useState(loadStoredAuth);
  const [tab,       setTab]       = useState(() => {
    const stored = loadStoredAuth();
    return stored?.role === 'manager' ? 'squad' : 'god';
  });
  const [focusTeam, setFocusTeam] = useState(null);
  const [syncing,      setSyncing]      = useState(false);
  const [syncMsg,      setSyncMsg]      = useState(null);
  const [recalculating, setRecalculating] = useState(false);
  const [recalcMsg,    setRecalcMsg]    = useState(null);
  const [theme,        setTheme]        = useState(loadTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('hs_theme', theme);
  }, [theme]);

  function handleLogin(authData) {
    setAuth(authData);
    setTab(authData.role === 'manager' ? 'squad' : 'god');
    if (authData.teamId) setFocusTeam(authData.teamId);
  }

  function handleLogout() {
    localStorage.removeItem('hs_token');
    localStorage.removeItem('hs_auth');
    setAuth(null);
  }

  function navigate({ tab: nextTab, teamId }) {
    if (teamId) setFocusTeam(teamId);
    setTab(nextTab);
  }

  if (!auth || auth.error) return <LoginPage onLogin={handleLogin} authError={auth?.error} />;

  async function handleRecalculate() {
    setRecalculating(true);
    setRecalcMsg(null);
    try {
      await recalculateDeps();
      setRecalcMsg('✓ Dependencies recalculated');
    } catch {
      setRecalcMsg('Recalculation failed');
    } finally {
      setRecalculating(false);
      setTimeout(() => setRecalcMsg(null), 4000);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await syncTeams();
      setSyncMsg(`✓ Synced ${res.synced} channel${res.synced !== 1 ? 's' : ''}`);
    } catch {
      setSyncMsg('Sync failed');
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 4000);
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: 'var(--bg-app)' }}>
      <header style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', padding: '0 32px', display: 'flex', alignItems: 'center', gap: 24, height: 58 }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', letterSpacing: -0.5 }}>
          HybridSync <span style={{ color: 'var(--accent)' }}>Admin</span>
        </span>
        <nav style={{ display: 'flex', gap: 4, marginLeft: 16 }}>
          {TABS.filter(t => t.roles.includes(auth.role)).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '6px 18px', borderRadius: 8, border: 'none',
                background: tab === t.id ? 'var(--bg-accent)' : 'transparent',
                color:      tab === t.id ? 'var(--accent-strong)' : 'var(--text-muted)',
                fontWeight: tab === t.id ? 700 : 400,
                cursor: 'pointer', fontSize: 14, transition: 'all 0.15s',
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {syncMsg   && <span style={{ fontSize: 12, color: '#22c55e' }}>{syncMsg}</span>}
          {recalcMsg && <span style={{ fontSize: 12, color: '#22c55e' }}>{recalcMsg}</span>}
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              fontSize: 14, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: '1.5px solid var(--border)', background: 'var(--bg-surface)',
              color: 'var(--text-primary)', lineHeight: 1,
            }}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          {auth.role === 'admin' && (
            <>
              <button
                onClick={handleRecalculate}
                disabled={recalculating}
                style={{
                  fontSize: 12, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
                  border: '1.5px solid #10b981', background: recalculating ? '#ecfdf5' : '#10b981',
                  color: recalculating ? '#10b981' : '#fff', fontWeight: 600,
                }}
              >
                {recalculating ? 'Recalculating…' : '⟳ Recalculate Dependencies'}
              </button>
              <button
                onClick={handleSync}
                disabled={syncing}
                style={{
                  fontSize: 12, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
                  border: '1.5px solid #6366f1', background: syncing ? '#eef2ff' : '#6366f1',
                  color: syncing ? '#6366f1' : '#fff', fontWeight: 600,
                }}
              >
                {syncing ? 'Syncing…' : '⟳ Sync Teams from Slack'}
              </button>
            </>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
            {auth.role === 'admin' ? '🏢' : '👥'} {auth.name}
          </span>
          <button
            onClick={handleLogout}
            style={{
              fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
              border: '1.5px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-muted)',
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px' }}>
        {tab === 'god'   && <GodView onNavigate={navigate} />}
        {tab === 'squad' && <SquadView focusTeam={focusTeam} />}
      </main>
    </div>
  );
}
