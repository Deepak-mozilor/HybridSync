import { useState, useEffect } from 'react';
import { login, fetchLoginTeams } from '../api';

export default function LoginPage({ onLogin }) {
  const [role,     setRole]     = useState('hr');
  const [password, setPassword] = useState('');
  const [teamId,   setTeamId]   = useState('');
  const [teams,    setTeams]    = useState([]);
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(false);

  useEffect(() => {
    fetchLoginTeams().then(t => {
      setTeams(t);
      if (t.length) setTeamId(t[0].id);
    }).catch(() => {});
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await login(role, password, role === 'manager' ? teamId : undefined);
      localStorage.setItem('hs_token', data.token);
      localStorage.setItem('hs_auth',  JSON.stringify({ role: data.role, teamId: data.teamId, name: data.name }));
      onLogin({ role: data.role, teamId: data.teamId, name: data.name });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* Logo / Brand */}
        <div style={styles.brand}>
          <span style={styles.brandText}>HybridSync</span>
          <span style={styles.brandSub}>Admin Dashboard</span>
        </div>

        {/* Role toggle */}
        <div style={styles.roleRow}>
          {['hr', 'manager'].map(r => (
            <button
              key={r}
              type="button"
              onClick={() => { setRole(r); setError(null); }}
              style={{ ...styles.roleBtn, ...(role === r ? styles.roleBtnActive : {}) }}
            >
              {r === 'hr' ? '🏢 HR Admin' : '👥 Team Manager'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          {/* Team selector — manager only */}
          {role === 'manager' && (
            <div style={styles.field}>
              <label style={styles.label}>Select Your Team</label>
              {teams.length === 0
                ? <p style={{ fontSize: 12, color: '#9ca3af' }}>No teams found — run Sync Teams first.</p>
                : (
                  <select
                    value={teamId}
                    onChange={e => setTeamId(e.target.value)}
                    style={styles.select}
                  >
                    {teams.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                )
              }
            </div>
          )}

          {/* Password */}
          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              style={styles.input}
            />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={loading} style={styles.submit}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: '#f1f5f9',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif',
  },
  card: {
    background: '#fff', borderRadius: 16, padding: '40px 36px',
    width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
  },
  brand: {
    textAlign: 'center', marginBottom: 28,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
  },
  brandText: { fontSize: 26, fontWeight: 800, color: '#1e293b', letterSpacing: -0.5 },
  brandSub:  { fontSize: 12, color: '#6366f1', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' },
  roleRow: {
    display: 'flex', gap: 8, marginBottom: 24,
    background: '#f8fafc', borderRadius: 10, padding: 4,
  },
  roleBtn: {
    flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
    background: 'transparent', cursor: 'pointer', fontSize: 13,
    fontWeight: 500, color: '#6b7280', transition: 'all 0.15s',
  },
  roleBtnActive: {
    background: '#fff', color: '#4f46e5', fontWeight: 700,
    boxShadow: '0 1px 4px rgba(0,0,0,0.10)',
  },
  field:  { marginBottom: 16 },
  label:  { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 },
  input:  {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    border: '1.5px solid #e5e7eb', fontSize: 14, outline: 'none',
    boxSizing: 'border-box', transition: 'border-color 0.15s',
  },
  select: {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    border: '1.5px solid #e5e7eb', fontSize: 14, outline: 'none',
    boxSizing: 'border-box', background: '#fff', cursor: 'pointer',
  },
  error:  {
    background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
    padding: '8px 12px', fontSize: 13, color: '#dc2626', marginBottom: 12,
  },
  submit: {
    width: '100%', padding: '11px 0', borderRadius: 8, border: 'none',
    background: '#6366f1', color: '#fff', fontSize: 14, fontWeight: 700,
    cursor: 'pointer', transition: 'background 0.15s', marginTop: 4,
  },
};
