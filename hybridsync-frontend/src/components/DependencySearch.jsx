import { useMemo, useState, useRef, useEffect } from 'react';

// Search bar that suggests users from the graph and, on select,
// shows the people the selected user depends on in decreasing score order.
//
// Edge shape from /api/graph:
//   source = A (lexicographically smaller id), target = B
//   data.scoreAB = A's dependency on B  (A → B)
//   data.scoreBA = B's dependency on A  (B → A)
export default function DependencySearch({ graph, teamFilter }) {
  const [query,         setQuery]         = useState('');
  const [showSuggest,   setShowSuggest]   = useState(false);
  const [selectedId,    setSelectedId]    = useState(null);
  const wrapRef = useRef(null);

  // Close suggestion dropdown on outside click.
  useEffect(() => {
    const onDocClick = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setShowSuggest(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const candidates = useMemo(() => {
    if (!graph?.nodes) return [];
    return graph.nodes.filter(n => {
      if (!teamFilter) return true;
      const ids = n.data.teamIds && n.data.teamIds.length ? n.data.teamIds : [n.data.team];
      return ids.includes(teamFilter);
    });
  }, [graph, teamFilter]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return candidates
      .filter(n => (n.data.label || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, query]);

  const selected = useMemo(
    () => (selectedId ? graph?.nodes.find(n => n.id === selectedId) : null),
    [graph, selectedId],
  );

  const dependencies = useMemo(() => {
    if (!selected || !graph?.edges) return [];
    const out = [];
    for (const e of graph.edges) {
      let peerId = null;
      let score  = null;
      if (e.source === selected.id) {
        peerId = e.target;
        score  = e.data?.scoreAB;
      } else if (e.target === selected.id) {
        peerId = e.source;
        score  = e.data?.scoreBA;
      }
      if (!peerId || score == null) continue;
      const peer = graph.nodes.find(n => n.id === peerId);
      out.push({
        id:    peerId,
        name:  peer?.data?.label || peerId,
        team:  peer?.data?.teamName || '',
        score,
      });
    }
    return out.sort((a, b) => b.score - a.score);
  }, [selected, graph]);

  const pickUser = u => {
    setSelectedId(u.id);
    setQuery(u.data.label);
    setShowSuggest(false);
  };

  const clear = () => {
    setSelectedId(null);
    setQuery('');
    setShowSuggest(false);
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div ref={wrapRef} style={{ position: 'relative', maxWidth: 420 }}>
        <input
          type="text"
          value={query}
          placeholder="Search a person to see who they depend on…"
          onChange={e => { setQuery(e.target.value); setShowSuggest(true); setSelectedId(null); }}
          onFocus={() => setShowSuggest(true)}
          style={{
            width: '100%', padding: '9px 34px 9px 12px', borderRadius: 8,
            border: '1.5px solid var(--border)', background: 'var(--bg-surface)',
            color: 'var(--text-primary)', fontSize: 14, outline: 'none',
          }}
        />
        {query && (
          <button
            onClick={clear}
            aria-label="Clear search"
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-faint)', fontSize: 16, padding: '2px 6px',
            }}
          >
            ×
          </button>
        )}

        {showSuggest && suggestions.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: 'var(--bg-surface)', border: '1.5px solid var(--border)',
            borderRadius: 8, boxShadow: 'var(--shadow)', zIndex: 20,
            maxHeight: 260, overflowY: 'auto',
          }}>
            {suggestions.map(s => (
              <button
                key={s.id}
                onClick={() => pickUser(s)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 12px', background: 'transparent', border: 'none',
                  cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-accent)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {s.data.label}
                {s.data.teamName && (
                  <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 8 }}>
                    {s.data.teamName}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div style={{
          marginTop: 14, background: 'var(--bg-surface)',
          border: '1.5px solid var(--border)', borderRadius: 10,
          padding: '14px 18px', maxWidth: 520,
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{selected.data.label}</strong> depends on:
          </div>
          {dependencies.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>No dependencies recorded.</div>
          ) : (
            <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {dependencies.map((d, i) => (
                <li key={d.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '7px 0',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                    <span style={{ color: 'var(--text-faint)', marginRight: 8 }}>{i + 1}.</span>
                    {d.name}
                    {d.team && (
                      <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 8 }}>
                        {d.team}
                      </span>
                    )}
                  </span>
                  <span style={{
                    fontSize: 12, fontWeight: 700,
                    color: d.score >= 9 ? '#ef4444' : d.score >= 7 ? '#f59e0b' : 'var(--accent-strong)',
                    background: 'var(--bg-muted)',
                    padding: '3px 9px', borderRadius: 12, minWidth: 28, textAlign: 'center',
                  }}>
                    {d.score}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
