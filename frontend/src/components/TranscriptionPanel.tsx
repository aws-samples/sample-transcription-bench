import React, { useState } from 'react';
import { ErrorCode, ModelStatus } from '../types/index';

interface TranscriptionPanelProps {
  modelName: string;
  status: ModelStatus;
  transcriptionText?: string;
  /** User-friendly summary, e.g. "Audio is too long for Voxtral Mini." */
  errorMessage?: string;
  /** Categorical code used to render an icon / badge / suggestion. */
  errorCode?: ErrorCode;
  /** Raw SDK / runtime message, surfaced in a collapsible disclosure. */
  errorDetails?: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: 'rgba(255,255,255,0.06)', text: 'rgba(255,255,255,0.4)' },
  PROCESSING: { bg: 'rgba(99,102,241,0.1)', text: '#818cf8' },
  COMPLETED: { bg: 'rgba(52,211,153,0.1)', text: '#34d399' },
  ERROR: { bg: 'rgba(248,113,113,0.1)', text: '#f87171' },
  TIMED_OUT: { bg: 'rgba(251,146,60,0.1)', text: '#fb923c' },
};

/**
 * Short label rendered as a chip above the error headline. Lets the user
 * recognise the failure category at a glance without parsing prose.
 */
const ERROR_LABELS: Record<ErrorCode, string> = {
  QUOTA_EXCEEDED: 'Quota exceeded',
  RATE_LIMITED: 'Rate limited',
  AUDIO_TOO_LONG: 'Audio too long',
  INVALID_AUDIO: 'Invalid audio',
  MODEL_TIMEOUT: 'Timed out',
  MODEL_UNAVAILABLE: 'Model unavailable',
  ENDPOINT_NOT_FOUND: 'Not deployed',
  PERMISSION_DENIED: 'Access denied',
  UNKNOWN: 'Error',
};

/**
 * Optional next-step hint shown under the headline. Kept short — the
 * headline already explains the cause; this nudges the user toward the
 * fix without being preachy.
 */
const ERROR_HINTS: Partial<Record<ErrorCode, string>> = {
  QUOTA_EXCEEDED: 'Open the AWS Service Quotas console to request an increase, or rerun this comparison once your quota window resets.',
  RATE_LIMITED: 'Wait a few seconds and run the comparison again.',
  AUDIO_TOO_LONG: 'Pick a shorter clip, or switch to a model with a longer audio limit (Whisper or AWS Transcribe).',
  MODEL_TIMEOUT: 'Retry the comparison — SageMaker endpoints often warm up after the first call.',
  MODEL_UNAVAILABLE: 'Try again in a moment, or pick a different model.',
  PERMISSION_DENIED: 'Enable model access for this account in the AWS Bedrock or SageMaker console.',
};

export default function TranscriptionPanel({
  modelName,
  status,
  transcriptionText,
  errorMessage,
  errorCode,
  errorDetails,
}: TranscriptionPanelProps) {
  const isLoading = status === 'PENDING' || status === 'PROCESSING';
  const isError = status === 'ERROR' || status === 'TIMED_OUT';
  const sc = STATUS_COLORS[status] ?? STATUS_COLORS.PENDING;
  const [showDetails, setShowDetails] = useState(false);

  // If we somehow have no friendly message (older record predating the
  // mapper), fall back to a status-appropriate default so the panel never
  // shows a bare "Error".
  const headline =
    errorMessage ?? (status === 'TIMED_OUT' ? 'Timed out.' : 'An error occurred.');
  const code: ErrorCode = errorCode ?? (status === 'TIMED_OUT' ? 'MODEL_TIMEOUT' : 'UNKNOWN');
  const hint = ERROR_HINTS[code];
  // Only show "Show details" when details actually add information beyond
  // the friendly headline. Avoids a useless toggle that just repeats itself.
  const detailsAreUseful = !!errorDetails && errorDetails !== errorMessage;

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <h3 style={s.name}>{modelName}</h3>
        <span style={{ ...s.badge, backgroundColor: sc.bg, color: sc.text }}>{status}</span>
      </div>
      <div style={s.body}>
        {isLoading && (
          <div style={s.loadWrap}>
            <div style={s.spinner} />
            <p style={s.loadText}>{status === 'PENDING' ? 'Waiting…' : 'Transcribing…'}</p>
          </div>
        )}
        {status === 'COMPLETED' && <p style={s.transcript}>{transcriptionText}</p>}
        {isError && (
          <div style={s.errWrap}>
            <div style={s.errHeader}>
              <span style={s.errChip}>{ERROR_LABELS[code]}</span>
            </div>
            <p style={s.errText}>{headline}</p>
            {hint && <p style={s.errHint}>{hint}</p>}
            {detailsAreUseful && (
              <div style={s.detailsBlock}>
                <button
                  type="button"
                  style={s.detailsToggle}
                  onClick={() => setShowDetails((v) => !v)}
                  aria-expanded={showDetails}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      marginRight: 5,
                      transform: showDetails ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.2s ease',
                    }}
                    aria-hidden="true"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  {showDetails ? 'Hide technical details' : 'Show technical details'}
                </button>
                {showDetails && <pre style={s.detailsText}>{errorDetails}</pre>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: 'rgba(28, 28, 30, 0.6)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.06)',
    overflow: 'hidden',
    boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 18px',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    background: 'rgba(0,0,0,0.15)',
  },
  name: { margin: 0, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.9)', letterSpacing: '-0.01em' },
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 6,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  body: { padding: 18, minHeight: 120 },
  loadWrap: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '2.5rem 0' },
  spinner: {
    width: 24, height: 24,
    border: '2px solid rgba(255,255,255,0.08)',
    borderTopColor: '#6366f1',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadText: { marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.3)' },
  transcript: { margin: 0, fontSize: 14, lineHeight: 1.75, color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap' as const },
  errWrap: {
    padding: 14,
    background: 'rgba(248,113,113,0.06)',
    borderRadius: 10,
    border: '1px solid rgba(248,113,113,0.15)',
  },
  errHeader: { display: 'flex', alignItems: 'center', marginBottom: 8 },
  errChip: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    background: 'rgba(248,113,113,0.18)',
    color: '#fca5a5',
  },
  errText: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: '#fca5a5',
    fontWeight: 500,
  },
  errHint: {
    margin: '8px 0 0',
    fontSize: 12,
    lineHeight: 1.55,
    color: 'rgba(252, 165, 165, 0.7)',
  },
  detailsBlock: {
    marginTop: 12,
    paddingTop: 10,
    borderTop: '1px solid rgba(248,113,113,0.12)',
  },
  detailsToggle: {
    background: 'none',
    border: 'none',
    color: 'rgba(252, 165, 165, 0.65)',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
  },
  detailsText: {
    margin: '8px 0 0',
    padding: '8px 10px',
    fontSize: 11,
    lineHeight: 1.55,
    color: 'rgba(255,255,255,0.55)',
    background: 'rgba(0,0,0,0.25)',
    borderRadius: 6,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    maxHeight: 180,
    overflowY: 'auto' as const,
  },
};
