import { useState, useEffect } from 'react';
import { getSampleAudio } from '../services/api';
import type { SampleAudio } from '../types';

interface SampleAudioPickerProps {
  token: string;
  onSelect: (s3Key: string, fileName: string) => void;
  disabled?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export default function SampleAudioPicker({ token, onSelect, disabled }: SampleAudioPickerProps) {
  const [samples, setSamples] = useState<SampleAudio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSampleAudio(token);
        if (!cancelled) setSamples(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load samples');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const handleSelect = (sample: SampleAudio) => {
    if (disabled) return;
    setSelected(sample.s3Key);
    onSelect(sample.s3Key, sample.name);
  };

  if (loading) return <p style={s.hint}>Loading sample files…</p>;
  if (error) return <p style={s.error}>{error}</p>;
  if (samples.length === 0) return <p style={s.hint}>No sample audio files available.</p>;

  return (
    <div style={s.container}>
      <div style={s.grid}>
        {samples.map((sample) => {
          const isSelected = selected === sample.s3Key;
          return (
            <button
              key={sample.s3Key}
              type="button"
              disabled={disabled}
              onClick={() => handleSelect(sample)}
              style={{
                ...s.card,
                ...(isSelected ? s.cardSelected : {}),
                ...(disabled ? s.cardDisabled : {}),
              }}
              aria-pressed={isSelected}
            >
              <div style={s.cardTop}>
                <div style={{ ...s.iconWrap, ...(isSelected ? s.iconWrapSelected : {}) }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M9 18V5l12-2v13" stroke={isSelected ? '#fff' : 'rgba(255,255,255,0.4)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <circle cx="6" cy="18" r="3" stroke={isSelected ? '#fff' : 'rgba(255,255,255,0.4)'} strokeWidth="1.5"/>
                    <circle cx="18" cy="16" r="3" stroke={isSelected ? '#fff' : 'rgba(255,255,255,0.4)'} strokeWidth="1.5"/>
                  </svg>
                </div>
                <div style={s.cardText}>
                  <span style={{ ...s.name, ...(isSelected ? s.nameSelected : {}) }}>
                    {sample.name}
                  </span>
                  <span style={s.size}>{formatSize(sample.sizeBytes)}</span>
                </div>
              </div>
              {isSelected && (
                <div style={s.checkCircle}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
            </button>
          );
        })}
      </div>
      {selected && (
        <div style={s.previewRow}>
          {(() => {
            const sel = samples.find((s) => s.s3Key === selected);
            return sel ? (
              <>
                <span style={s.previewLabel}>Preview</span>
                <audio
                  controls
                  src={sel.previewUrl}
                  style={s.audioPlayer}
                  onPlay={() => setPlayingUrl(sel.previewUrl)}
                  onPause={() => setPlayingUrl(null)}
                  onEnded={() => setPlayingUrl(null)}
                >
                  Your browser does not support the audio element.
                </audio>
              </>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: {},
  grid: { display: 'flex', flexWrap: 'wrap' as const, gap: 10 },
  card: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 16px', borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.2)',
    cursor: 'pointer',
    transition: 'all 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
    position: 'relative' as const, textAlign: 'left' as const,
    minWidth: 0,
  },
  cardSelected: {
    borderColor: 'rgba(99,102,241,0.4)',
    background: 'rgba(99,102,241,0.06)',
    boxShadow: '0 0 0 1px rgba(99,102,241,0.2)',
  },
  cardDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  cardTop: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  iconWrap: {
    width: 32, height: 32, borderRadius: 8,
    background: 'rgba(255,255,255,0.04)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    transition: 'background 0.2s ease',
  },
  iconWrapSelected: { background: 'rgba(99,102,241,0.6)' },
  cardText: { display: 'flex', flexDirection: 'column' as const, gap: 2, minWidth: 0 },
  name: {
    fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.7)',
    overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const,
  },
  nameSelected: { color: 'rgba(255,255,255,0.95)', fontWeight: 600 },
  size: { fontSize: 11, color: 'rgba(255,255,255,0.25)' },
  checkCircle: {
    width: 18, height: 18, borderRadius: '50%', background: '#6366f1',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  hint: { color: 'rgba(255,255,255,0.3)', fontSize: 13 },
  error: { color: '#f87171', fontSize: 13 },
  previewRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    marginTop: 14, padding: '10px 14px',
    background: 'rgba(0,0,0,0.2)', borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.04)',
  },
  previewLabel: { fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' as const },
  audioPlayer: { flex: 1, height: 32, borderRadius: 8 },
};
