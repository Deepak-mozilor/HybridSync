import { useEffect, useState, useCallback } from 'react';
import { fetchGraph, fetchWeekSchedule, fetchTeams } from '../api';
import GraphView    from '../components/GraphView';
import ScheduleGrid from '../components/ScheduleGrid';
import AnchorEditor from '../components/AnchorEditor';

export default function SquadView({ focusTeam }) {
  const [graph,      setGraph]      = useState(null);
  const [schedule,   setSchedule]   = useState(null);
  const [teams,      setTeams]      = useState([]);
  const [activeTeam, setActiveTeam] = useState(null);
  const [error,      setError]      = useState(null);
  const [lastSync,   setLastSync]   = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const [g, s, t] = await Promise.all([fetchGraph(), fetchWeekSchedule(), fetchTeams()]);
      setGraph(g);
      setSchedule(s);
      setTeams(t);
      setActiveTeam(prev => focusTeam ?? prev ?? (t[0]?.id || null));
      setLastSync(new Date());
      setError(null);
    } catch {
      setError('Cannot reach the server. Please try again in a moment.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <div style={{ color: '#ef4444', padding: 20 }}>{error}</div>;

  const filteredSchedule = schedule
    ? { ...schedule, rows: schedule.rows.filter(r => r.user.teamId === activeTeam) }
    : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h2 style={h2Style}>Manager Squad View</h2>
        <button onClick={() => load(true)} disabled={refreshing} style={refreshBtn}>
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
        {lastSync && <span style={{ fontSize: 11, color: '#9ca3af' }}>Updated {lastSync.toLocaleTimeString()}</span>}
      </div>
      <p style={{ color: '#6b7280', marginBottom: 20 }}>
        Filtered dependency graph and schedules for your team. Set Anchor Days below to require office attendance.
      </p>

      {teams.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {teams.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTeam(t.id)}
              style={{
                padding: '8px 20px', borderRadius: 20, border: '2px solid',
                borderColor: activeTeam === t.id ? '#6366f1' : '#e5e7eb',
                background:  activeTeam === t.id ? '#eef2ff' : '#fff',
                color:       activeTeam === t.id ? '#4f46e5' : '#374151',
                fontWeight:  activeTeam === t.id ? 700 : 400,
                cursor: 'pointer', fontSize: 14,
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <GraphView graphData={graph} filterTeam={activeTeam} />

      <h3 style={{ ...h2Style, fontSize: 17, marginTop: 32 }}>Team Schedule This Week</h3>
      <ScheduleGrid rows={filteredSchedule?.rows} dates={schedule?.dates} />

      <h3 style={{ ...h2Style, fontSize: 17, marginTop: 32 }}>Anchor Days</h3>
      <p style={{ color: '#6b7280', marginBottom: 14, fontSize: 13 }}>
        Toggle which days are mandated office days. Changes save instantly and appear in the Slack App Home.
      </p>
      <AnchorEditor teams={teams.filter(t => t.id === activeTeam)} onSaved={load} />
    </div>
  );
}

const h2Style  = { fontSize: 20, fontWeight: 700, marginBottom: 0, marginTop: 0 };
const refreshBtn = {
  fontSize: 12, padding: '4px 12px', borderRadius: 6,
  border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: '#4f46e5',
};
