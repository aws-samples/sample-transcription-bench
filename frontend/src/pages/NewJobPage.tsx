import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AudioUploader from '../components/AudioUploader';
import SampleAudioPicker from '../components/SampleAudioPicker';
import GroundTruthUploader from '../components/GroundTruthUploader';
import ModelSelector from '../components/ModelSelector';
import { useAuth } from '../hooks/useAuth';
import { getModels, createJob } from '../services/api';
import type { ModelInfo } from '../types';

type AudioSource = 'upload' | 'sample';

export default function NewJobPage() {
  const { getJwtToken } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [audioSource, setAudioSource] = useState<AudioSource>('sample');
  const [s3Key, setS3Key] = useState<string | null>(null);
  const [audioFileName, setAudioFileName] = useState<string | null>(null);
  const [groundTruthS3Key, setGroundTruthS3Key] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const jwt = await getJwtToken();
        if (cancelled || !jwt) return;
        setToken(jwt);
        const catalog = await getModels(jwt);
        if (!cancelled) setModels(catalog);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load models');
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => { cancelled = true; };
  }, [getJwtToken]);

  const canSubmit = !!s3Key && selectedModelIds.length >= 2 && !submitting;

  const handleStart = async () => {
    if (!canSubmit || !s3Key) return;
    setError('');
    setSubmitting(true);
    try {
      const jwt = await getJwtToken();
      if (!jwt) throw new Error('Your session has expired. Please sign in again.');
      const { jobId } = await createJob(
        jwt,
        s3Key,
        selectedModelIds,
        groundTruthS3Key ?? undefined,
      );
      navigate(`/jobs/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job');
      setSubmitting(false);
    }
  };

  const switchSource = (source: AudioSource) => {
    setAudioSource(source);
    setS3Key(null);
    setAudioFileName(null);
  };

  return (
    <div style={st.container} className="animate-in">
      <div style={st.header}>
        <button type="button" style={st.back} onClick={() => navigate('/dashboard')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <h1 style={st.title}>New Comparison</h1>
      </div>

      {/* Step 1: Audio */}
      <div style={st.card}>
        <div style={st.step}>
          <div style={st.stepNum}>1</div>
          <div style={st.stepContent}>
            <h2 style={st.stepTitle}>Choose Audio</h2>
            <div style={st.tabRow}>
              <button
                type="button"
                style={{ ...st.tab, ...(audioSource === 'sample' ? st.tabActive : {}) }}
                onClick={() => switchSource('sample')}
              >
                Sample Files
              </button>
              <button
                type="button"
                style={{ ...st.tab, ...(audioSource === 'upload' ? st.tabActive : {}) }}
                onClick={() => switchSource('upload')}
              >
                Upload Your Own
              </button>
            </div>

            {audioSource === 'sample' && token && (
              <SampleAudioPicker
                token={token}
                disabled={submitting}
                onSelect={(key, name) => { setS3Key(key); setAudioFileName(name); }}
              />
            )}

            {audioSource === 'upload' && token && (
              <AudioUploader
                getToken={getJwtToken}
                onUploadComplete={(key) => { setS3Key(key); setAudioFileName(null); }}
              />
            )}

            {!token && loadingModels && <p style={st.loadingText}>Authenticating…</p>}

            {s3Key && (
              <p style={st.selectedHint}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Audio selected{audioFileName ? `: ${audioFileName}` : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Step 2: Models */}
      <div style={st.card}>
        <div style={st.step}>
          <div style={st.stepNum}>2</div>
          <div style={st.stepContent}>
            <h2 style={st.stepTitle}>Choose Models</h2>
            <p style={st.stepDesc}>Select 2 to 5 models to compare</p>
            {loadingModels ? (
              <p style={st.loadingText}>Loading models…</p>
            ) : (
              <ModelSelector models={models} selectedModelIds={selectedModelIds} onSelectionChange={setSelectedModelIds} />
            )}
          </div>
        </div>
      </div>

      {/* Step 3: Ground Truth (optional) */}
      <div style={st.card}>
        <div style={st.step}>
          <div style={st.stepNumOpt}>3</div>
          <div style={st.stepContent}>
            <h2 style={st.stepTitle}>
              Ground Truth
              <span style={st.optionalBadge}>Optional</span>
            </h2>
            <p style={st.stepDesc}>
              Upload a .txt file with the actual transcription to compare accuracy against both models.
            </p>
            {token && (
              <GroundTruthUploader
                getToken={getJwtToken}
                onUploadComplete={(key) => setGroundTruthS3Key(key)}
                onClear={() => setGroundTruthS3Key(null)}
              />
            )}
          </div>
        </div>
      </div>

      {error && <div style={st.error}>{error}</div>}

      <button type="button" disabled={!canSubmit} onClick={handleStart}
        style={{ ...st.submitBtn, ...(canSubmit ? {} : st.submitBtnOff) }}>
        {submitting ? 'Starting…' : 'Start Comparison'}
      </button>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  container: { maxWidth: 860, margin: '0 auto', padding: '40px 24px' },
  header: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 },
  back: {
    display: 'flex', alignItems: 'center', gap: 4,
    background: 'none', border: 'none', color: '#818cf8',
    fontSize: 13, fontWeight: 500, cursor: 'pointer', padding: 0,
  },
  title: { margin: 0, fontSize: 28, fontWeight: 600, color: 'rgba(255,255,255,0.95)', letterSpacing: '-0.03em' },
  card: {
    background: 'rgba(28, 28, 30, 0.55)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderRadius: 16, border: '1px solid rgba(255,255,255,0.06)',
    padding: '24px 28px', marginBottom: 16,
    boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
  },
  step: { display: 'flex', gap: 18, alignItems: 'flex-start' },
  stepNum: {
    width: 28, height: 28, borderRadius: '50%',
    background: 'linear-gradient(135deg, #6366f1, #818cf8)', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 700, flexShrink: 0,
  },
  stepNumOpt: {
    width: 28, height: 28, borderRadius: '50%',
    background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 700, flexShrink: 0,
  },
  stepContent: { flex: 1, minWidth: 0 },
  stepTitle: {
    margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.9)',
    display: 'flex', alignItems: 'center', gap: 10, letterSpacing: '-0.01em',
  },
  stepDesc: { margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 },
  optionalBadge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 5,
    fontSize: 9, fontWeight: 600, background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  loadingText: { color: 'rgba(255,255,255,0.3)', fontSize: 13 },
  tabRow: {
    display: 'inline-flex', gap: 0, marginBottom: 16,
    borderRadius: 10, overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(0,0,0,0.2)',
  },
  tab: {
    padding: '8px 18px', border: 'none',
    background: 'transparent', color: 'rgba(255,255,255,0.4)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    transition: 'all 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
  },
  tabActive: { background: 'rgba(99,102,241,0.9)', color: '#fff' },
  selectedHint: {
    marginTop: 14, fontSize: 13, fontWeight: 500, color: '#34d399',
    display: 'flex', alignItems: 'center',
  },
  error: {
    padding: '12px 16px', borderRadius: 12,
    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)',
    color: '#fca5a5', fontSize: 13, marginBottom: 16,
  },
  submitBtn: {
    padding: '14px 36px', fontSize: 14, fontWeight: 600, borderRadius: 12,
    border: 'none', background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
    color: '#fff', cursor: 'pointer',
    transition: 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.2s ease',
    boxShadow: '0 2px 12px rgba(99, 102, 241, 0.3)',
    letterSpacing: '-0.01em',
  },
  submitBtnOff: {
    background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.2)',
    cursor: 'not-allowed', boxShadow: 'none',
  },
};
