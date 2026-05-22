const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';
const INSTALL_URL = 'https://hybridsync-backend-production.up.railway.app/slack/install';

export default function LoginPage({ onLogin, authError }) {
  const handleSlackLogin = () => {
    window.location.href = `${BASE.replace('/api', '')}/api/auth/slack`;
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.brand}>
          <span style={styles.logo}>🔁</span>
          <span style={styles.brandText}>HybridSync</span>
          <span style={styles.brandSub}>Admin Dashboard</span>
        </div>

        <p style={styles.desc}>
          Sign in with your Slack account to access the dashboard.
          Admins see the full organisation · Managers see their team.
        </p>

        {authError && (
          <div style={styles.error}>{authError}</div>
        )}

        <button onClick={handleSlackLogin} style={styles.slackBtn}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.521 2.528 2.528 0 0 1-2.521-2.521 2.527 2.527 0 0 1 2.521-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="white"/>
          </svg>
          Sign in with Slack
        </button>

        <a href={INSTALL_URL} style={styles.installLink}>
          + Add HybridSync to your Slack workspace
        </a>

        <p style={styles.hint}>
          Only authorised team members can access this dashboard.
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: 'var(--bg-app)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif',
  },
  card: {
    background: 'var(--bg-surface)', borderRadius: 16, padding: '40px 36px',
    width: 400, boxShadow: 'var(--shadow)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0,
    border: '1px solid var(--border)',
  },
  brand: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 4, marginBottom: 20,
  },
  logo:      { fontSize: 48, lineHeight: 1, marginBottom: 6 },
  brandText: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: -0.5 },
  brandSub:  { fontSize: 12, color: 'var(--accent)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' },
  desc: {
    fontSize: 13, color: 'var(--text-muted)', textAlign: 'center',
    lineHeight: 1.6, marginBottom: 24,
  },
  slackBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    width: '100%', padding: '13px 0', borderRadius: 8, border: 'none',
    background: '#4A154B', color: '#fff', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', transition: 'opacity 0.15s', marginBottom: 16,
  },
  error: {
    width: '100%', background: '#fef2f2', border: '1px solid #fecaca',
    borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#dc2626',
    marginBottom: 16, textAlign: 'center',
  },
  installLink: {
    fontSize: 13, color: 'var(--accent-strong)', textDecoration: 'none', fontWeight: 600,
    marginBottom: 16, textAlign: 'center',
  },
  hint: {
    fontSize: 11, color: 'var(--text-faint)', textAlign: 'center', margin: 0,
  },
};
