import { useState, useEffect } from 'react';
import { updateAnchor } from '../api';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export default function AnchorEditor({ teams, onSaved }) {
  const [saving, setSaving] = useState(null);
  const [localTeams, setLocalTeams] = useState(teams);

  useEffect(() => { setLocalTeams(teams); }, [teams]);

  async function toggle(teamId, day) {
    const team    = localTeams.find(t => t.id === teamId);
    const current = team.anchorDays || [];
    const next    = current.includes(day) ? current.filter(d => d !== day) : [...current, day];

    setLocalTeams(ts => ts.map(t => t.id === teamId ? { ...t, anchorDays: next } : t));
    setSaving(teamId);
    await updateAnchor(teamId, next);
    setSaving(null);
    onSaved?.();
  }

  if (!localTeams?.length) return <p style={{ color: 'var(--text-muted)' }}>No teams found.</p>;

  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
      {localTeams.map(team => (
        <div key={team.id} style={{ background: 'var(--bg-muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 20px', minWidth: 220 }}>
          <div style={{ fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)' }}>{team.name}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {DAYS.map(day => {
              const active = (team.anchorDays || []).includes(day);
              return (
                <button
                  key={day}
                  onClick={() => toggle(team.id, day)}
                  disabled={saving === team.id}
                  style={{
                    padding:      '6px 14px',
                    borderRadius: 8,
                    border:       '2px solid',
                    borderColor:  active ? 'var(--accent)' : 'var(--border-strong)',
                    background:   active ? 'var(--bg-accent)' : 'var(--bg-surface)',
                    color:        active ? 'var(--accent-strong)' : 'var(--text-muted)',
                    fontWeight:   active ? 700 : 400,
                    cursor:       'pointer',
                    fontSize:     13,
                    transition:   'all 0.15s',
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
          {saving === team.id && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)' }}>Saving…</div>}
        </div>
      ))}
    </div>
  );
}
