import React, { useMemo } from 'react';
import DiffMatchPatch from 'diff-match-patch';

interface DiffViewerProps { textA: string; textB: string; labelA?: string; labelB?: string; }
const dmp = new DiffMatchPatch();

export default function DiffViewer({ textA, textB, labelA = 'Model A', labelB = 'Model B' }: DiffViewerProps) {
  const { segmentsA, segmentsB } = useMemo(() => {
    const diffs = dmp.diff_main(textA, textB);
    dmp.diff_cleanupSemantic(diffs);
    const segsA: { text: string; type: 'equal' | 'removed' }[] = [];
    const segsB: { text: string; type: 'equal' | 'added' }[] = [];
    for (const [op, text] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) { segsA.push({ text, type: 'equal' }); segsB.push({ text, type: 'equal' }); }
      else if (op === DiffMatchPatch.DIFF_DELETE) segsA.push({ text, type: 'removed' });
      else if (op === DiffMatchPatch.DIFF_INSERT) segsB.push({ text, type: 'added' });
    }
    return { segmentsA: segsA, segmentsB: segsB };
  }, [textA, textB]);

  const identical = textA === textB;

  return (
    <div style={s.container}>
      {identical && (
        <div style={s.banner}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Transcriptions are identical
        </div>
      )}
      <div style={s.columns} className="diff-columns">
        <div style={s.col} className="diff-column">
          <h4 style={s.label}>{labelA}</h4>
          <div style={s.text}>
            {segmentsA.map((seg, i) => <span key={i} style={seg.type === 'removed' ? s.removed : undefined}>{seg.text}</span>)}
          </div>
        </div>
        <div style={s.divider} className="diff-divider" />
        <div style={s.col} className="diff-column">
          <h4 style={s.label}>{labelB}</h4>
          <div style={s.text}>
            {segmentsB.map((seg, i) => <span key={i} style={seg.type === 'added' ? s.added : undefined}>{seg.text}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: {
    background: 'rgba(28, 28, 30, 0.5)',
    backdropFilter: 'blur(12px)',
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.06)',
    overflow: 'hidden',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
  },
  banner: {
    margin: 0, padding: '10px 18px',
    background: 'rgba(52, 211, 153, 0.06)',
    color: '#34d399', fontSize: 13, fontWeight: 500,
    display: 'flex', alignItems: 'center',
    borderBottom: '1px solid rgba(52, 211, 153, 0.08)',
  },
  columns: { display: 'flex', gap: 0 },
  col: { flex: 1, minWidth: 0, padding: '16px 20px' },
  divider: { width: 1, background: 'rgba(255,255,255,0.04)', flexShrink: 0 },
  label: {
    margin: '0 0 10px', fontSize: 10, fontWeight: 500,
    color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  text: {
    fontSize: 13, lineHeight: 1.8, color: 'rgba(255,255,255,0.7)',
    whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
  },
  removed: {
    background: 'rgba(248, 113, 113, 0.12)',
    textDecoration: 'line-through',
    textDecorationColor: 'rgba(248, 113, 113, 0.5)',
    borderRadius: 3, padding: '1px 3px',
    color: 'rgba(248, 113, 113, 0.9)',
  },
  added: {
    background: 'rgba(52, 211, 153, 0.12)',
    borderRadius: 3, padding: '1px 3px',
    color: 'rgba(52, 211, 153, 0.9)',
  },
};
