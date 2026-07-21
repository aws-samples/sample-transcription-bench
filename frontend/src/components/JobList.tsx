import type { JobSummary } from '../types';

interface JobListProps {
  jobs: JobSummary[];
  onJobClick: (jobId: string) => void;
  onDelete: (jobId: string) => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNextPage: () => void;
  onPreviousPage: () => void;
  loading: boolean;
}

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  COMPLETED: { backgroundColor: 'rgba(52, 211, 153, 0.1)', color: '#34d399' },
  PENDING: { backgroundColor: 'rgba(251, 191, 36, 0.1)', color: '#fbbf24' },
  IN_PROGRESS: { backgroundColor: 'rgba(99, 102, 241, 0.1)', color: '#818cf8' },
  PARTIAL: { backgroundColor: 'rgba(168, 85, 247, 0.1)', color: '#c084fc' },
  FAILED: { backgroundColor: 'rgba(248, 113, 113, 0.1)', color: '#f87171' },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function JobList({ jobs, onJobClick, onDelete, hasNextPage, hasPreviousPage, onNextPage, onPreviousPage, loading }: JobListProps) {
  if (loading) return (
    <div style={s.loading}>
      <div style={s.loadingDot} />
      <span>Loading jobs…</span>
    </div>
  );

  if (jobs.length === 0) return (
    <div style={s.empty}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeLinecap="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <p style={s.emptyTitle}>No transcription jobs yet</p>
      <p style={s.emptySub}>Create a new comparison to get started.</p>
    </div>
  );

  const sorted = [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div>
      <div className="job-table-wrapper">
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Status</th>
              <th style={s.th}>Models</th>
              <th style={s.th}>Created</th>
              <th style={{ ...s.th, width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((job) => (
              <tr key={job.jobId} style={s.row} onClick={() => onJobClick(job.jobId)}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJobClick(job.jobId); } }}>
                <td style={s.td}>
                  <span style={{ ...s.badge, ...(STATUS_STYLES[job.status] ?? {}) }}>{job.status}</span>
                </td>
                <td style={{ ...s.td, ...s.modelCell }}>{job.modelIds.join(' vs ')}</td>
                <td style={{ ...s.td, ...s.dateCell }}>{formatDate(job.createdAt)}</td>
                <td style={s.td}>
                  <button
                    type="button"
                    title="Delete job"
                    aria-label={`Delete job created ${formatDate(job.createdAt)}`}
                    style={s.deleteBtn}
                    onClick={(e) => { e.stopPropagation(); onDelete(job.jobId); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={s.pagination}>
        <button type="button" disabled={!hasPreviousPage} onClick={onPreviousPage}
          style={{ ...s.pageBtn, ...(hasPreviousPage ? {} : s.pageBtnOff) }}>← Previous</button>
        <button type="button" disabled={!hasNextPage} onClick={onNextPage}
          style={{ ...s.pageBtn, ...(hasNextPage ? {} : s.pageBtnOff) }}>Next →</button>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  loading: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    color: 'rgba(255,255,255,0.35)', padding: '3rem 0', fontSize: 14,
  },
  loadingDot: {
    width: 6, height: 6, borderRadius: '50%', background: 'rgba(99,102,241,0.6)',
    animation: 'pulse 1.2s ease infinite',
  },
  empty: { textAlign: 'center', padding: '4rem 1rem', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8 },
  emptyTitle: { margin: 0, fontSize: 15, fontWeight: 500, color: 'rgba(255,255,255,0.5)' },
  emptySub: { margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.25)' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: {
    textAlign: 'left' as const, padding: '12px 20px', fontSize: 11, fontWeight: 500,
    color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase' as const,
    letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  row: {
    cursor: 'pointer',
    transition: 'background 0.15s ease',
  },
  td: {
    padding: '14px 20px', fontSize: 13, color: 'rgba(255,255,255,0.7)',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    transition: 'background 0.15s ease',
  },
  modelCell: { fontWeight: 500, color: 'rgba(255,255,255,0.85)' },
  dateCell: { color: 'rgba(255,255,255,0.4)', fontSize: 12 },
  badge: {
    display: 'inline-block', padding: '3px 10px', borderRadius: 6,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  pagination: { display: 'flex', justifyContent: 'space-between', padding: '14px 20px' },
  pageBtn: {
    padding: '7px 14px', fontSize: 12, fontWeight: 500, borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)',
    color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  pageBtnOff: { color: 'rgba(255,255,255,0.15)', cursor: 'not-allowed', borderColor: 'rgba(255,255,255,0.03)' },
  deleteBtn: {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)', cursor: 'pointer',
    padding: 6, borderRadius: 6, display: 'inline-flex', alignItems: 'center',
    transition: 'color 0.15s ease, background 0.15s ease',
  },
};
