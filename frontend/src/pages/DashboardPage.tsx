import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getJobs, deleteJob } from '../services/api';
import JobList from '../components/JobList';
import type { JobSummary } from '../types';

const PAGE_LIMIT = 10;

export default function DashboardPage() {
  const { getJwtToken } = useAuth();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [currentCursor, setCurrentCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const fetchJobs = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError('');
    try {
      const token = await getJwtToken();
      if (!token) return;
      const response = await getJobs(token, cursor, PAGE_LIMIT);
      setJobs(response.jobs);
      setNextCursor(response.nextCursor);
      setCurrentCursor(cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [getJwtToken]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, currentCursor]);
    fetchJobs(nextCursor);
  };
  const handlePreviousPage = () => {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1];
    setCursorHistory((prev) => prev.slice(0, -1));
    fetchJobs(prevCursor);
  };

  const handleDelete = useCallback(async (jobId: string) => {
    setDeleteTarget(jobId);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteTarget(null);
    try {
      const token = await getJwtToken();
      if (!token) return;
      await deleteJob(token, deleteTarget);
      setJobs((prev) => prev.filter((j) => j.jobId !== deleteTarget));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
    }
  }, [deleteTarget, getJwtToken]);

  return (
    <div style={s.container} className="animate-in">
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Dashboard</h1>
          <p style={s.subtitle}>Your transcription comparison jobs</p>
        </div>
        <button type="button" style={s.newBtn} onClick={() => navigate('/new-job')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Comparison
        </button>
      </div>
      {error && <div style={s.error}>{error}</div>}
      <div style={s.card}>
        <JobList
          jobs={jobs}
          onJobClick={(jobId) => navigate(`/jobs/${jobId}`)}
          onDelete={handleDelete}
          hasNextPage={!!nextCursor}
          hasPreviousPage={cursorHistory.length > 0}
          onNextPage={handleNextPage}
          onPreviousPage={handlePreviousPage}
          loading={loading}
        />
      </div>

      {deleteTarget && (
        <div style={s.overlay} onClick={() => setDeleteTarget(null)} role="presentation">
          <div style={s.modal} className="animate-in-scale" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Confirm deletion">
            <div style={s.modalIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <p style={s.modalTitle}>Delete this job?</p>
            <p style={s.modalText}>This action is permanent and cannot be undone.</p>
            <div style={s.modalActions}>
              <button type="button" style={s.cancelBtn} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" style={s.confirmBtn} onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { maxWidth: 960, margin: '0 auto', padding: '40px 24px' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 },
  title: { margin: 0, fontSize: 28, fontWeight: 600, color: 'rgba(255,255,255,0.95)', letterSpacing: '-0.03em' },
  subtitle: { margin: '6px 0 0', fontSize: 14, color: 'rgba(255,255,255,0.4)', fontWeight: 400 },
  newBtn: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 18px', fontSize: 13, fontWeight: 600, borderRadius: 10,
    border: 'none', background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
    color: '#fff', cursor: 'pointer',
    transition: 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease',
    boxShadow: '0 2px 8px rgba(99, 102, 241, 0.25)',
  },
  error: {
    padding: '12px 16px', borderRadius: 12,
    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
    color: '#fca5a5', fontSize: 13, marginBottom: 16,
  },
  card: {
    background: 'rgba(28, 28, 30, 0.6)',
    backdropFilter: 'blur(20px) saturate(1.5)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.06)',
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
  },
  overlay: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  },
  modal: {
    background: 'rgba(44, 44, 46, 0.95)',
    backdropFilter: 'blur(30px)',
    borderRadius: 16, border: '1px solid rgba(255,255,255,0.08)',
    padding: '28px 32px', maxWidth: 340, width: '90%', textAlign: 'center' as const,
    boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
  },
  modalIcon: { marginBottom: 12 },
  modalTitle: { margin: '0 0 8px', fontSize: 17, fontWeight: 600, color: 'rgba(255,255,255,0.92)' },
  modalText: { margin: '0 0 24px', fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 },
  modalActions: { display: 'flex', justifyContent: 'center', gap: 10 },
  cancelBtn: {
    padding: '9px 20px', fontSize: 13, fontWeight: 600, borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
  },
  confirmBtn: {
    padding: '9px 20px', fontSize: 13, fontWeight: 600, borderRadius: 10,
    border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer',
  },
};
