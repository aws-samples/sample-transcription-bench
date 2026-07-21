import React, { useState } from 'react';
import type { ModelEvaluation } from '../types';

interface EvaluationCardProps {
  evaluation?: ModelEvaluation;
  hasGroundTruth: boolean;
  /**
   * When true, the judge rationale is always rendered and the show/hide
   * toggle is omitted. Used by PDF export so the rationale is included
   * regardless of whether the user has it expanded on screen.
   */
  forceExpanded?: boolean;
}

const dash = '—';

function fmtPct(value?: number): string {
  if (value === undefined || value === null) return dash;
  return `${(value * 100).toFixed(1)}%`;
}

function fmtScore(value?: number): string {
  if (value === undefined || value === null) return dash;
  return `${Math.round(value)} / 100`;
}

function errorRateColor(value?: number): string {
  if (value === undefined || value === null) return 'rgba(255,255,255,0.3)';
  if (value <= 0.05) return '#34d399';
  if (value <= 0.15) return '#fbbf24';
  return '#f87171';
}

function judgeScoreColor(score?: number): string {
  if (score === undefined || score === null) return 'rgba(255,255,255,0.3)';
  if (score >= 85) return '#34d399';
  if (score >= 60) return '#fbbf24';
  return '#f87171';
}

export default function EvaluationCard({ evaluation, hasGroundTruth, forceExpanded = false }: EvaluationCardProps) {
  const [showRationale, setShowRationale] = useState(false);
  const rationaleVisible = forceExpanded || showRationale;

  if (!hasGroundTruth) return null;

  if (!evaluation || evaluation.status === 'PENDING') {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.title}>Accuracy</span>
          <span style={s.statusPending}>
            <span style={s.pulsingDot} />
            Evaluating
          </span>
        </div>
      </div>
    );
  }

  if (evaluation.status === 'SKIPPED') {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.title}>Accuracy</span>
          <span style={s.statusMuted}>No ground truth</span>
        </div>
      </div>
    );
  }

  if (evaluation.status === 'ERROR' && !hasAnyMetric(evaluation)) {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.title}>Accuracy</span>
          <span style={s.statusError}>Failed</span>
        </div>
        {evaluation.errorMessage && (
          <p style={s.errMsg}>{evaluation.errorMessage}</p>
        )}
      </div>
    );
  }

  return (
    <div style={s.card}>
      <div style={s.header}>
        <span style={s.title}>Accuracy</span>
      </div>

      <div style={s.metricsRow}>
        <Metric label="WER" value={fmtPct(evaluation.wer)} color={errorRateColor(evaluation.wer)} error={evaluation.errors?.wer} />
        <Metric
          label="MER"
          value={fmtPct(evaluation.mer)}
          color={errorRateColor(evaluation.mer)}
          error={evaluation.errors?.mer}
          subtext={
            evaluation.merTotal != null && evaluation.merMissed != null
              ? `${evaluation.merMissed}/${evaluation.merTotal} missed`
              : undefined
          }
        />
        <Metric label="Sem WER" value={fmtPct(evaluation.semanticWer)} color={errorRateColor(evaluation.semanticWer)} error={evaluation.errors?.semanticWer} />
        <Metric
          label="Judge"
          value={fmtScore(evaluation.llmJudge?.score)}
          color={judgeScoreColor(evaluation.llmJudge?.score)}
          error={evaluation.errors?.llmJudge}
        />
      </div>

      {evaluation.llmJudge?.rationale && (
        <div style={s.rationaleBlock}>
          {!forceExpanded && (
            <button
              type="button"
              style={s.rationaleToggle}
              onClick={() => setShowRationale((v) => !v)}
              aria-expanded={showRationale}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, transform: showRationale ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s ease' }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              {showRationale ? 'Hide rationale' : 'Show judge rationale'}
            </button>
          )}
          {rationaleVisible && (
            <p style={s.rationaleText}>{evaluation.llmJudge.rationale}</p>
          )}
        </div>
      )}
    </div>
  );
}

function hasAnyMetric(e: ModelEvaluation): boolean {
  return e.wer != null || e.mer != null || e.semanticWer != null || e.llmJudge != null;
}

interface MetricProps {
  label: string;
  value: string;
  color: string;
  error?: string;
  subtext?: string;
}

function Metric({ label, value, color, error, subtext }: MetricProps) {
  return (
    <div style={s.metric} title={error ? `Failed: ${error}` : undefined}>
      <span style={s.metricLabel}>{label}</span>
      <span style={{ ...s.metricValue, color: error ? 'rgba(255,255,255,0.2)' : color }}>
        {error ? '—' : value}
      </span>
      {!error && subtext && <span style={s.metricSubtext}>{subtext}</span>}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 12,
    background: 'rgba(0, 0, 0, 0.25)',
    padding: '14px 18px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.3)',
    textTransform: 'uppercase' as const, letterSpacing: '0.06em',
  },
  statusPending: { fontSize: 11, fontWeight: 500, color: '#818cf8', display: 'flex', alignItems: 'center', gap: 6 },
  pulsingDot: {
    width: 6, height: 6, borderRadius: '50%', background: '#818cf8',
    animation: 'pulse 1.5s ease infinite',
  },
  statusMuted: { fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.25)' },
  statusError: { fontSize: 11, fontWeight: 500, color: '#f87171' },
  errMsg: { margin: '8px 0 0', fontSize: 12, color: '#f87171' },
  metricsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
  },
  metric: { display: 'flex', flexDirection: 'column' as const, gap: 3 },
  metricLabel: {
    fontSize: 9, fontWeight: 500, color: 'rgba(255,255,255,0.25)',
    textTransform: 'uppercase' as const, letterSpacing: '0.06em',
  },
  metricValue: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em' },
  metricSubtext: {
    fontSize: 9, fontWeight: 400, color: 'rgba(255,255,255,0.25)', marginTop: 1,
  },
  rationaleBlock: { marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.04)' },
  rationaleToggle: {
    background: 'none', border: 'none',
    color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 500,
    cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center',
    transition: 'color 0.15s ease',
  },
  rationaleText: {
    margin: '10px 0 0', fontSize: 12, lineHeight: 1.7,
    color: 'rgba(255,255,255,0.45)', fontStyle: 'italic' as const,
  },
};
