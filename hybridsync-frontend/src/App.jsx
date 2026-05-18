import { useState } from 'react';
import GodView    from './views/GodView';
import SquadView  from './views/SquadView';
import LoginPage  from './views/LoginPage';
import { syncTeams, recalculateDeps } from './api';

const TABS = [
  { id: 'god',   label: 'HR God View',       icon: '🏢', roles: ['hr'] },
  { id: 'squad', label: 'Manager Squad View', icon: '👥', roles: ['hr', 'manager'] },
];

function loadStoredAuth() {
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

  if (!auth) return <LoginPage onLogin={handleLogin} />;

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
    <div style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#f8fafc' }}>
      <header style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '0 32px', display: 'flex', alignItems: 'center', gap: 24, height: 58 }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: '#1e293b', letterSpacing: -0.5 }}>
          HybridSync <span style={{ color: '#6366f1' }}>Admin</span>
        </span>
        <nav style={{ display: 'flex', gap: 4, marginLeft: 16 }}>
          {TABS.filter(t => t.roles.includes(auth.role)).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '6px 18px', borderRadius: 8, border: 'none',
                background: tab === t.id ? '#eef2ff' : 'transparent',
                color:      tab === t.id ? '#4f46e5' : '#6b7280',
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
          {auth.role === 'hr' && (
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
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>
            {auth.role === 'hr' ? '🏢' : '👥'} {auth.name}
          </span>
          <button
            onClick={handleLogout}
            style={{
              fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
              border: '1.5px solid #e5e7eb', background: '#fff', color: '#6b7280',
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
