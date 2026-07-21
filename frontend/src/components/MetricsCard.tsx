import React from 'react';

interface MetricsCardProps { latencyMs?: number; estimatedCostUsd?: number; }

export default function MetricsCard({ latencyMs, estimatedCostUsd }: MetricsCardProps) {
  const dash = '—';
  return (
    <div style={s.card}>
      <div style={s.metric}>
        <span style={s.label}>Latency</span>
        <span style={s.value}>
          {latencyMs !== undefined ? `${latencyMs.toLocaleString('en-US', { maximumFractionDigits: 0 })} ms` : dash}
        </span>
      </div>
      <div style={s.divider} />
      <div style={s.metric}>
        <span style={s.label}>Est. Cost</span>
        <span style={s.value}>
          {estimatedCostUsd !== undefined ? `$${estimatedCostUsd.toFixed(4)}` : dash}
        </span>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex', alignItems: 'center',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 12,
    background: 'rgba(0, 0, 0, 0.25)',
    padding: '12px 18px', gap: 18,
  },
  metric: { display: 'flex', flexDirection: 'column' as const, flex: 1 },
  label: {
    fontSize: 10, fontWeight: 500, color: 'rgba(255,255,255,0.3)',
    textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 3,
  },
  value: { fontSize: 16, fontWeight: 600, color: 'rgba(255,255,255,0.9)', letterSpacing: '-0.02em' },
  divider: { width: 1, height: 28, background: 'rgba(255,255,255,0.06)', flexShrink: 0 },
};
