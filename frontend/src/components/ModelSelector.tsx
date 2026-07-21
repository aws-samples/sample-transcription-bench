import React, { useCallback } from 'react';
import { ModelInfo } from '../types/index';

interface ModelSelectorProps {
  models: ModelInfo[];
  selectedModelIds: string[];
  onSelectionChange: (modelIds: string[]) => void;
}

const PROVIDER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  bedrock: { bg: 'rgba(99,102,241,0.08)', text: '#818cf8', border: 'rgba(99,102,241,0.2)' },
  sagemaker: { bg: 'rgba(168,85,247,0.08)', text: '#c084fc', border: 'rgba(168,85,247,0.2)' },
  transcribe: { bg: 'rgba(251,146,60,0.08)', text: '#fb923c', border: 'rgba(251,146,60,0.2)' },
};

export default function ModelSelector({ models, selectedModelIds, onSelectionChange }: ModelSelectorProps) {
  const maxReached = selectedModelIds.length >= 5;

  const handleToggle = useCallback((modelId: string) => {
    if (selectedModelIds.includes(modelId)) {
      onSelectionChange(selectedModelIds.filter((id) => id !== modelId));
    } else if (!maxReached) {
      onSelectionChange([...selectedModelIds, modelId]);
    }
  }, [selectedModelIds, maxReached, onSelectionChange]);

  return (
    <div>
      <p style={s.counter}>
        Selected: <span style={s.counterNum}>{selectedModelIds.length}</span> / 5
        {selectedModelIds.length < 2 && <span style={s.counterHint}> (minimum 2)</span>}
      </p>
      <div style={s.grid} className="model-grid">
        {models.map((model) => {
          const isSelected = selectedModelIds.includes(model.modelId);
          const isDisabled = maxReached && !isSelected;
          const prov = PROVIDER_COLORS[model.provider] ?? PROVIDER_COLORS.bedrock;
          return (
            <div key={model.modelId} role="button" tabIndex={isDisabled ? -1 : 0}
              aria-pressed={isSelected} aria-disabled={isDisabled}
              onClick={() => !isDisabled && handleToggle(model.modelId)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !isDisabled) { e.preventDefault(); handleToggle(model.modelId); } }}
              style={{ ...s.card, ...(isSelected ? s.cardSel : {}), ...(isDisabled ? s.cardOff : {}) }}>
              <div style={{ ...s.check, ...(isSelected ? s.checkOn : {}) }}>
                {isSelected && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              <span style={{ ...s.badge, backgroundColor: prov.bg, color: prov.text }}>{model.provider}</span>
              <h3 style={s.name}>{model.modelName}</h3>
              <p style={s.desc}>{model.description}</p>
              <div style={s.meta}>
                <span style={s.cost}>
                  {model.costPerMinute != null
                    ? `$${model.costPerMinute.toFixed(3)}/min`
                    : `$${model.inputCostPer1kTokens?.toFixed(2)}/$${model.outputCostPer1kTokens?.toFixed(2)} per 1k tokens`}
                  {model.provider === 'sagemaker' && (
                    <SagemakerCostInfo
                      instanceType={model.instanceType}
                      hourlyRateUsd={model.instanceHourlyRateUsd}
                    />
                  )}
                </span>
                <span style={s.formats}>
                  {model.supportedFormats.map((f) => f.replace('audio/', '').toUpperCase()).join(', ')}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SagemakerCostInfoProps {
  instanceType?: string;
  hourlyRateUsd?: number;
}

function SagemakerCostInfo({ instanceType, hourlyRateUsd }: SagemakerCostInfoProps) {
  const tooltip =
    instanceType && hourlyRateUsd != null
      ? `SageMaker bills per instance-hour, not per minute of audio. ` +
        `${instanceType} costs $${hourlyRateUsd.toFixed(4)}/hr while the endpoint is running, ` +
        `whether or not it's invoked. The displayed $/min is the best-case rate at ` +
        `100% utilization (hourlyRate / 60). Real cost rises sharply at lower utilization.`
      : 'SageMaker bills per instance-hour while the endpoint is running, ' +
        'not per minute of audio. The displayed $/min assumes 100% utilization.';

  return (
    <span
      role="img"
      aria-label="SageMaker pricing details"
      title={tooltip}
      onClick={(e) => e.stopPropagation()}
      style={s.infoIcon}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </span>
  );
}

const s: Record<string, React.CSSProperties> = {
  counter: { margin: '0 0 14px', fontSize: 13, color: 'rgba(255,255,255,0.35)' },
  counterNum: { color: '#818cf8', fontWeight: 600 },
  counterHint: { color: 'rgba(255,255,255,0.25)', fontWeight: 400 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  card: {
    position: 'relative' as const,
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 14, padding: 20, cursor: 'pointer',
    background: 'rgba(0,0,0,0.2)',
    transition: 'border-color 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s cubic-bezier(0.22, 1, 0.36, 1), transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
  },
  cardSel: {
    borderColor: 'rgba(99,102,241,0.4)',
    boxShadow: '0 0 0 1px rgba(99,102,241,0.2), 0 4px 16px rgba(99,102,241,0.1)',
    background: 'rgba(99,102,241,0.04)',
  },
  cardOff: { opacity: 0.3, cursor: 'not-allowed', transform: 'scale(0.98)' },
  check: {
    position: 'absolute' as const, top: 14, right: 14,
    width: 20, height: 20, borderRadius: '50%',
    border: '1.5px solid rgba(255,255,255,0.15)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.2s ease',
  },
  checkOn: { borderColor: '#6366f1', background: '#6366f1' },
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 5,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.05em', marginBottom: 10,
  },
  name: { margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', letterSpacing: '-0.01em' },
  desc: { margin: '0 0 14px', fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 },
  meta: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 12,
  },
  cost: { fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.75)', display: 'inline-flex', alignItems: 'center', gap: 6 },
  infoIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(255,255,255,0.4)', cursor: 'help',
  },
  formats: { fontSize: 10, color: 'rgba(255,255,255,0.25)' },
};
