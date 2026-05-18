import { useEffect, useState, useCallback } from 'react';
import { fetchGraph, fetchWeekSchedule } from '../api';
import GraphView    from '../components/GraphView';
import ScheduleGrid from '../components/ScheduleGrid';

export default function GodView({ onNavigate }) {
  const [graph,       setGraph]       = useState(null);
  const [schedule,    setSchedule]    = useState(null);
  const [error,       setError]       = useState(null);
  const [lastSync,    setLastSync]    = useState(null);
  const [refreshing,  setRefreshing]  = useState(false);
  const [expandedCard, setExpandedCard] = useState(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const [g, s] = await Promise.all([fetchGraph(), fetchWeekSchedule()]);
      setGraph(g);
      setSchedule(s);
      setLastSync(new Date());
      setError(null);
    } catch {
      setError('Cannot reach backend. Is the server running on port 3001?');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <div style={{ color: '#ef4444', padding: 20 }}>{error}</div>;

  const stats = graph
    ? (() => {
        const nodeById   = id => graph.nodes.find(n => n.id === id);
        const nodeLabel  = id => nodeById(id)?.data?.label ?? id;
        const nodeTeam   = id => nodeById(id)?.data?.team ?? null;
        const edgeItem   = e => ({
          key:    `${e.source}-${e.target}`,
          label:  `${nodeLabel(e.source)} → ${nodeLabel(e.target)}`,
          teamId: nodeTeam(e.source),
        });
        const criticalEdges = graph.edges.filter(e => e.data.score >= 9);
        const highRiskEdges = graph.edges.filter(e => e.data.score >= 7 && e.data.score < 9);
        return {
          users:         graph.nodes.length,
          userNodes:     graph.nodes.map(n => ({ key: n.id, label: n.data.label, teamId: n.data.team })),
          edges:         graph.edges.length,
          edgeItems:     graph.edges.map(edgeItem),
          critical:      criticalEdges.length,
          criticalItems: criticalEdges.map(edgeItem),
          highRisk:      highRiskEdges.length,
          highRiskItems: highRiskEdges.map(edgeItem),
        };
      })()
    : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h2 style={h2Style}>HR God View — Company Dependency Graph</h2>
        <button onClick={() => load(true)} disabled={refreshing} style={refreshBtn}>
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
        {lastSync && <span style={{ fontSize: 11, color: '#9ca3af' }}>Updated {lastSync.toLocaleTimeString()}</span>}
      </div>
      <p style={{ color: '#6b7280', marginBottom: 20 }}>
        Full collaboration dependency graph across all teams. Animated edges = critical pairs (score ≥ 9).
      </p>

      {stats && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {[
            { id: 'users',    label: 'Total Users',      value: stats.users,    color: '#6366f1', items: stats.userNodes },
            { id: 'edges',    label: 'Dependency Edges', value: stats.edges,    color: '#0ea5e9', items: stats.edgeItems },
            { id: 'critical', label: 'Critical Pairs',   value: stats.critical, color: '#ef4444', items: stats.criticalItems },
            { id: 'highRisk', label: 'High-Risk Pairs',  value: stats.highRisk, color: '#f59e0b', items: stats.highRiskItems },
          ].map(s => {
            const open = expandedCard === s.id;
            return (
              <div key={s.id} style={{ flex: '1 1 130px', position: 'relative' }}>
                <button
                  onClick={() => setExpandedCard(open ? null : s.id)}
                  style={{
                    width: '100%', textAlign: 'left', background: '#fff',
                    border: `1.5px solid ${open ? s.color : '#e5e7eb'}`,
                    borderRadius: 10, padding: '14px 22px', cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div style={{ fontSize: 26, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {s.label}
                    <span style={{ fontSize: 10, color: s.color }}>{open ? '▲' : '▼'}</span>
                  </div>
                </button>

                {open && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
                    background: '#fff', border: `1.5px solid ${s.color}`,
                    borderRadius: 10, padding: '10px 12px', zIndex: 10,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
                    minWidth: 180,
                  }}>
                    {s.items.length === 0
                      ? <div style={{ fontSize: 12, color: '#9ca3af' }}>None</div>
                      : s.items.map(item => (
                          <button
                            key={item.key}
                            onClick={() => { setExpandedCard(null); onNavigate({ tab: 'squad', teamId: item.teamId }); }}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              background: '#f8fafc', border: '1px solid #e5e7eb',
                              borderRadius: 6, padding: '5px 10px', marginBottom: 4,
                              fontSize: 12, color: '#1e293b', cursor: 'pointer',
                              fontWeight: 500,
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = '#eef2ff'}
                            onMouseLeave={e => e.currentTarget.style.background = '#f8fafc'}
                          >
                            {item.label}
                            <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>→ Squad View</span>
                          </button>
                        ))
                    }
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <GraphView graphData={graph} />

      <h3 style={{ ...h2Style, fontSize: 17, marginTop: 32 }}>This Week's Schedule</h3>
      <ScheduleGrid rows={schedule?.rows} dates={schedule?.dates} />
    </div>
  );
}

const h2Style  = { fontSize: 20, fontWeight: 700, marginBottom: 0, marginTop: 0 };
const refreshBtn = {
  fontSize: 12, padding: '4px 12px', borderRadius: 6,
  border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: '#4f46e5',
};
