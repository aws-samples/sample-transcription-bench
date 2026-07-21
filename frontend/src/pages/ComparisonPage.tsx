import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useWebSocket } from '../hooks/useWebSocket';
import { getJobDetail, getModels } from '../services/api';
import { downloadElementAsPdf } from '../services/pdfExport';
import TranscriptionPanel from '../components/TranscriptionPanel';
import MetricsCard from '../components/MetricsCard';
import EvaluationCard from '../components/EvaluationCard';
import DiffViewer from '../components/DiffViewer';
import type { ErrorCode, JobDetailResponse, ModelEvaluation, ModelInfo, ModelResult, ModelStatus } from '../types';

interface ModelResultState {
  status: ModelStatus;
  transcriptionText?: string;
  errorMessage?: string;
  errorCode?: ErrorCode;
  errorDetails?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
  evaluation?: ModelEvaluation;
}

const spinCSS = `@keyframes cp-spin { to { transform: rotate(360deg); } }`;
if (typeof document !== 'undefined') { const el = document.createElement('style'); el.textContent = spinCSS; document.head.appendChild(el); }

export default function ComparisonPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { getJwtToken } = useAuth();
  const { messages, connect, disconnect } = useWebSocket();
  const [job, setJob] = useState<JobDetailResponse | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelInfo[]>([]);
  const [results, setResults] = useState<Record<string, ModelResultState>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [pdfMode, setPdfMode] = useState(false);
  const [diffPair, setDiffPair] = useState<[number, number]>([0, 1]);
  const printableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getJwtToken();
        if (cancelled || !token) return;
        const [jobDetail, catalog] = await Promise.all([getJobDetail(token, jobId), getModels(token)]);
        if (cancelled) return;
        setJob(jobDetail);
        setModelCatalog(catalog);
        const initial: Record<string, ModelResultState> = {};
        for (const modelId of jobDetail.modelIds) {
          const existing = jobDetail.results.find((r: ModelResult) => r.modelId === modelId);
          initial[modelId] = existing
            ? {
                status: existing.status,
                transcriptionText: existing.transcriptionText,
                errorMessage: existing.errorMessage,
                errorCode: existing.errorCode,
                errorDetails: existing.errorDetails,
                latencyMs: existing.latencyMs,
                estimatedCostUsd: existing.estimatedCostUsd,
                evaluation: existing.evaluation,
              }
            : { status: 'PENDING' };
        }
        setResults(initial);
        connect(token);
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load job'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; disconnect(); };
  }, [jobId, getJwtToken, connect, disconnect]);

  useEffect(() => {
    if (!jobId || messages.length === 0) return;
    const latest = messages[messages.length - 1];
    if (latest.jobId !== jobId || !latest.modelId) return;

    if (latest.action === 'RESULT') {
      const isError = latest.status === 'ERROR' || latest.status === 'TIMED_OUT';
      setResults((prev) => ({
        ...prev,
        [latest.modelId!]: {
          ...(prev[latest.modelId!] ?? { status: 'PENDING' }),
          status: latest.status ?? 'COMPLETED',
          transcriptionText: isError ? undefined : latest.transcriptionText,
          errorMessage: isError
            ? latest.errorMessage ?? prev[latest.modelId!]?.errorMessage ?? 'An error occurred.'
            : undefined,
          errorCode: isError ? latest.errorCode ?? prev[latest.modelId!]?.errorCode : undefined,
          errorDetails: isError ? latest.errorDetails ?? prev[latest.modelId!]?.errorDetails : undefined,
          latencyMs: latest.metrics?.latencyMs,
          estimatedCostUsd: latest.metrics?.estimatedCostUsd,
        },
      }));
      return;
    }

    if (latest.action === 'EVALUATION' && latest.evaluation) {
      setResults((prev) => ({
        ...prev,
        [latest.modelId!]: {
          ...(prev[latest.modelId!] ?? { status: 'PENDING' }),
          evaluation: latest.evaluation,
        },
      }));
    }
  }, [messages, jobId]);

  const getModelName = useCallback((modelId: string) => modelCatalog.find((m) => m.modelId === modelId)?.modelName ?? modelId, [modelCatalog]);

  const handleDownload = useCallback(async () => {
    if (!printableRef.current || !jobId) return;
    setDownloading(true);
    flushSync(() => setPdfMode(true));
    try {
      await downloadElementAsPdf(printableRef.current, {
        fileName: `transcribebench-${jobId}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate PDF');
    } finally {
      setPdfMode(false);
      setDownloading(false);
    }
  }, [jobId]);

  const modelIds = job?.modelIds ?? [];
  const modelCount = modelIds.length;
  const isMulti = modelCount > 2;
  const terminal: ModelStatus[] = ['COMPLETED', 'ERROR', 'TIMED_OUT'];
  const allCompleted = useMemo(() => modelIds.every((id) => {
    const r = results[id];
    return r && terminal.includes(r.status);
  }), [modelIds, results]);

  const completedModels = useMemo(() =>
    modelIds.filter((id) => results[id]?.status === 'COMPLETED' && !!results[id]?.transcriptionText),
  [modelIds, results]);

  const groundTruth = job?.groundTruthText;
  const hasGroundTruth = !!groundTruth;

  // Diff pair management
  const diffA = modelIds[diffPair[0]];
  const diffB = modelIds[diffPair[1]];
  const canDiff = diffA && diffB && results[diffA]?.transcriptionText && results[diffB]?.transcriptionText;

  if (loading) return (
    <div style={s.container}>
      <div style={s.loadWrap}><div style={s.spinner} /><p style={s.loadText}>Loading job…</p></div>
    </div>
  );

  if (error) return (
    <div style={s.container}>
      <div style={s.errBanner}>{error}</div>
      <button type="button" style={s.back} onClick={() => navigate('/dashboard')}>← Back to Dashboard</button>
    </div>
  );

  return (
    <div style={s.container}>
      <div style={s.controlBar} data-pdf-ignore="true">
        <button type="button" style={s.back} onClick={() => navigate('/dashboard')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          Back
        </button>
        <div style={s.controlBarRight}>
          <button type="button" style={s.guideLink} onClick={() => navigate('/metrics-guide')}>
            Metrics Guide →
          </button>
          <button
            type="button"
            style={{ ...s.downloadBtn, ...(!allCompleted || downloading ? s.downloadBtnDisabled : {}) }}
            onClick={handleDownload}
            disabled={!allCompleted || downloading}
          >
            {downloading ? (
              <><span style={s.btnSpinner} /> Generating PDF…</>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                Download
              </>
            )}
          </button>
        </div>
      </div>

      <div ref={printableRef} style={s.printable}>
        <div style={s.header}>
          <h1 style={s.title}>Comparison Results</h1>
          <div style={s.badges}>
            {allCompleted && <span style={s.doneBadge}>Complete</span>}
            {hasGroundTruth && <span style={s.gtBadge}>Ground Truth</span>}
            <span style={s.modelCountBadge}>{modelCount} models</span>
          </div>
        </div>

        {job?.audioUrl && (
          <div style={s.audioSection} data-pdf-ignore="true">
            <span style={s.audioLabel}>Audio</span>
            <audio controls src={job.audioUrl} style={s.audioPlayer}>
              Your browser does not support the audio element.
            </audio>
          </div>
        )}

        {/* ── Leaderboard Summary ── */}
        {allCompleted && modelCount >= 2 && (
          <div style={s.leaderboard}>
            <div style={s.leaderboardHeader}>
              <h2 style={s.leaderboardTitle}>Summary</h2>
            </div>
            <div style={s.leaderboardGrid}>
              <div style={s.leaderboardCol}>
                <span style={s.leaderboardLabel}>Model</span>
              </div>
              <div style={s.leaderboardCol}>
                <span style={s.leaderboardLabel}>Latency</span>
              </div>
              <div style={s.leaderboardCol}>
                <span style={s.leaderboardLabel}>Cost</span>
              </div>
              {hasGroundTruth && (
                <div style={s.leaderboardCol}>
                  <span style={s.leaderboardLabel}>WER</span>
                </div>
              )}
              <div style={s.leaderboardCol}>
                <span style={s.leaderboardLabel}>Status</span>
              </div>
            </div>
            {modelIds.map((modelId, idx) => {
              const r = results[modelId];
              const isWinner = r?.latencyMs != null && modelIds.every((other) => {
                const otherR = results[other];
                return other === modelId || !otherR?.latencyMs || r.latencyMs! <= otherR.latencyMs;
              });
              return (
                <div key={modelId} style={{ ...s.leaderboardRow, ...(idx === modelIds.length - 1 ? { borderBottom: 'none' } : {}) }}>
                  <div style={s.leaderboardCol}>
                    <span style={{ ...s.leaderboardModel, ...(isWinner ? s.leaderboardWinner : {}) }}>
                      {isWinner && <span style={s.winnerDot} />}
                      {getModelName(modelId)}
                    </span>
                  </div>
                  <div style={s.leaderboardCol}>
                    <span style={s.leaderboardValue}>{r?.latencyMs != null ? `${r.latencyMs.toLocaleString()} ms` : '—'}</span>
                  </div>
                  <div style={s.leaderboardCol}>
                    <span style={s.leaderboardValue}>{r?.estimatedCostUsd != null ? `$${r.estimatedCostUsd.toFixed(4)}` : '—'}</span>
                  </div>
                  {hasGroundTruth && (
                    <div style={s.leaderboardCol}>
                      <span style={s.leaderboardValue}>{r?.evaluation?.wer != null ? `${(r.evaluation.wer * 100).toFixed(1)}%` : '—'}</span>
                    </div>
                  )}
                  <div style={s.leaderboardCol}>
                    <span style={{ ...s.leaderboardStatus, color: r?.status === 'COMPLETED' ? '#34d399' : '#f87171' }}>
                      {r?.status === 'COMPLETED' ? '✓' : '✕'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Model Result Cards ── */}
        <div style={isMulti ? s.panelsGrid : s.panels} className={isMulti ? 'model-grid' : 'panels-row'}>
          {modelIds.map((modelId) => {
            const r = results[modelId];
            return (
              <div key={modelId} style={s.panelCol}>
                <TranscriptionPanel
                  modelName={getModelName(modelId)}
                  status={r?.status ?? 'PENDING'}
                  transcriptionText={r?.transcriptionText}
                  errorMessage={r?.errorMessage}
                  errorCode={r?.errorCode}
                  errorDetails={r?.errorDetails}
                />
                <MetricsCard latencyMs={r?.latencyMs} estimatedCostUsd={r?.estimatedCostUsd} />
                {hasGroundTruth && (
                  <EvaluationCard evaluation={r?.evaluation} hasGroundTruth={hasGroundTruth} forceExpanded={pdfMode} />
                )}
              </div>
            );
          })}
        </div>

        {/* ── Ground truth reference ── */}
        {hasGroundTruth && (
          <section style={s.gtSection}>
            <h2 style={s.sectionTitle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ marginRight: 8 }}>
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Ground Truth
            </h2>
            <div style={s.gtTextBox}>
              <p style={s.gtText}>{groundTruth}</p>
            </div>
          </section>
        )}

        {/* ── Diff Section ── */}
        {completedModels.length >= 2 && (
          <section style={s.diffSection}>
            {hasGroundTruth && (
              <>
                <h2 style={s.sectionTitle}>Accuracy vs Ground Truth</h2>
                <p style={s.diffDesc}>Each model compared against the reference transcription.</p>
                <div style={s.gtDiffGrid}>
                  {completedModels.map((modelId) => {
                    const r = results[modelId];
                    if (!r?.transcriptionText) return null;
                    return (
                      <div key={modelId}>
                        <DiffViewer
                          textA={groundTruth!}
                          textB={r.transcriptionText}
                          labelA="Ground Truth"
                          labelB={getModelName(modelId)}
                        />
                      </div>
                    );
                  })}
                </div>
                <div style={s.diffSpacer} />
              </>
            )}

            <h2 style={s.sectionTitle}>Model-to-Model Differences</h2>

            {/* Pair selector — only shown for 3+ models */}
            {isMulti && completedModels.length >= 2 && (
              <div style={s.pairSelector} data-pdf-ignore="true">
                <span style={s.pairLabel}>Compare:</span>
                <select
                  style={s.pairSelect}
                  value={diffPair[0]}
                  onChange={(e) => setDiffPair([Number(e.target.value), diffPair[1]])}
                >
                  {modelIds.map((id, idx) => (
                    <option key={id} value={idx} disabled={idx === diffPair[1]}>{getModelName(id)}</option>
                  ))}
                </select>
                <span style={s.pairVs}>vs</span>
                <select
                  style={s.pairSelect}
                  value={diffPair[1]}
                  onChange={(e) => setDiffPair([diffPair[0], Number(e.target.value)])}
                >
                  {modelIds.map((id, idx) => (
                    <option key={id} value={idx} disabled={idx === diffPair[0]}>{getModelName(id)}</option>
                  ))}
                </select>
              </div>
            )}

            {canDiff && (
              <DiffViewer
                textA={results[diffA]!.transcriptionText!}
                textB={results[diffB]!.transcriptionText!}
                labelA={getModelName(diffA)}
                labelB={getModelName(diffB)}
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { maxWidth: 1100, margin: '0 auto', padding: '40px 24px' },
  loadWrap: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '5rem 0' },
  spinner: { width: 28, height: 28, border: '2px solid rgba(255,255,255,0.06)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'cp-spin 0.8s linear infinite' },
  loadText: { marginTop: 16, fontSize: 13, color: 'rgba(255,255,255,0.3)' },
  errBanner: { padding: '14px 18px', borderRadius: 12, background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)', color: '#fca5a5', fontSize: 14, marginBottom: 16 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 24, flexWrap: 'wrap' as const },
  back: { display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: '#818cf8', fontSize: 13, fontWeight: 500, cursor: 'pointer', padding: 0 },
  title: { margin: 0, fontSize: 28, fontWeight: 600, color: 'rgba(255,255,255,0.95)', letterSpacing: '-0.03em' },
  badges: { display: 'flex', gap: 8, alignItems: 'center' },
  doneBadge: { padding: '4px 10px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: 'rgba(52,211,153,0.1)', color: '#34d399', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  gtBadge: { padding: '4px 10px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: 'rgba(99,102,241,0.1)', color: '#818cf8', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  modelCountBadge: { padding: '4px 10px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  controlBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 24, flexWrap: 'wrap' as const },
  controlBarRight: { display: 'flex', alignItems: 'center', gap: 12 },
  guideLink: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: 12, fontWeight: 500, cursor: 'pointer', padding: 0, transition: 'color 0.15s ease' },
  printable: { display: 'block' },
  downloadBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '7px 14px', borderRadius: 10,
    background: 'rgba(99,102,241,0.1)', color: '#818cf8',
    border: '1px solid rgba(99,102,241,0.2)',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  downloadBtnDisabled: { opacity: 0.35, cursor: 'not-allowed' },
  btnSpinner: { width: 12, height: 12, borderRadius: '50%', border: '1.5px solid rgba(129,140,248,0.3)', borderTopColor: '#818cf8', animation: 'cp-spin 0.8s linear infinite', display: 'inline-block' },

  /* ── Leaderboard ── */
  leaderboard: {
    background: 'rgba(28, 28, 30, 0.5)',
    backdropFilter: 'blur(16px)',
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.06)',
    padding: '20px 24px',
    marginBottom: 24,
    boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
  },
  leaderboardHeader: { marginBottom: 16 },
  leaderboardTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', letterSpacing: '-0.01em' },
  leaderboardGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.5fr', gap: 8, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.04)' },
  leaderboardRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 0.5fr', gap: 8, padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', alignItems: 'center' },
  leaderboardCol: {},
  leaderboardLabel: { fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase' as const, letterSpacing: '0.06em' },
  leaderboardModel: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center', gap: 6 },
  leaderboardWinner: { color: '#34d399' },
  winnerDot: { width: 6, height: 6, borderRadius: '50%', background: '#34d399', flexShrink: 0 },
  leaderboardValue: { fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.6)' },
  leaderboardStatus: { fontSize: 14, fontWeight: 600 },

  /* ── Panels ── */
  panels: { display: 'flex', gap: 16, marginBottom: 28, alignItems: 'stretch' },
  panelsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16, marginBottom: 28 },
  panelCol: { flex: 1, width: 0, display: 'flex', flexDirection: 'column' as const, gap: 12, minWidth: 0 },

  /* ── Audio ── */
  audioSection: { display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', background: 'rgba(28,28,30,0.5)', backdropFilter: 'blur(12px)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)', marginBottom: 20 },
  audioLabel: { fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' as const },
  audioPlayer: { flex: 1, height: 32, borderRadius: 8 },

  /* ── Sections ── */
  diffSection: { marginTop: 8 },
  diffSpacer: { height: 24 },
  diffDesc: { margin: '0 0 14px', fontSize: 13, color: 'rgba(255,255,255,0.35)' },
  sectionTitle: { margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center', letterSpacing: '-0.01em' },
  gtSection: { marginBottom: 24 },
  gtTextBox: { padding: '14px 18px', background: 'rgba(28,28,30,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)' },
  gtText: { margin: 0, fontSize: 13, lineHeight: 1.8, color: 'rgba(255,255,255,0.6)', whiteSpace: 'pre-wrap' as const },
  gtDiffGrid: { display: 'flex', flexDirection: 'column' as const, gap: 14 },

  /* ── Pair Selector (for 3+ models) ── */
  pairSelector: {
    display: 'flex', alignItems: 'center', gap: 10,
    marginBottom: 16, padding: '10px 16px',
    background: 'rgba(0,0,0,0.2)', borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.04)',
  },
  pairLabel: { fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: 500 },
  pairSelect: {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8, padding: '6px 10px', color: 'rgba(255,255,255,0.85)',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    appearance: 'none' as const, WebkitAppearance: 'none' as const,
    paddingRight: 24,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
  },
  pairVs: { fontSize: 11, color: 'rgba(255,255,255,0.2)', fontWeight: 600 },
};
