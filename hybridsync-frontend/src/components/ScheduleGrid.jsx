const STATUS_COLOR = {
  WFH:    '#3b82f6',
  Office: '#22c55e',
  Sick:   '#ef4444',
  Leave:  '#f59e0b',
};

const STATUS_BG = {
  WFH:    '#eff6ff',
  Office: '#f0fdf4',
  Sick:   '#fef2f2',
  Leave:  '#fffbeb',
};

export default function ScheduleGrid({ rows, dates }) {
  if (!rows || !dates) return <p style={{ color: '#6b7280' }}>Loading schedule…</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={th()}>User</th>
            <th style={th()}>Team</th>
            {dates.map(d => (
              <th key={d.dateKey} style={th()}>{d.day}<br /><span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 11 }}>{d.dateKey}</span></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ user, schedule }) => (
            <tr key={user.id}>
              <td style={td()}><strong>{user.displayName}</strong><br /><span style={{ color: '#6b7280', fontSize: 11 }}>{user.id}</span></td>
              <td style={td()}>{user.teamName || user.teamId}</td>
              {schedule.map(s => (
                <td key={s.dateKey} style={{ ...td(), textAlign: 'center' }}>
                  {s.status ? (
                    <span style={{
                      display:      'inline-block',
                      padding:      '3px 10px',
                      borderRadius: 12,
                      background:   STATUS_BG[s.status]  || '#f3f4f6',
                      color:        STATUS_COLOR[s.status] || '#374151',
                      fontWeight:   600,
                      fontSize:     12,
                    }}>{s.status}</span>
                  ) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th = () => ({ padding: '8px 14px', background: '#f9fafb', borderBottom: '2px solid #e5e7eb', textAlign: 'left', whiteSpace: 'nowrap' });
const td = () => ({ padding: '8px 14px', borderBottom: '1px solid #f3f4f6' });
