import { useCallback, useRef, useState } from 'react';
import { requestUploadUrl } from '../services/api';

const MAX_FILE_SIZE = 1_048_576; // 1 MB

type UploadState = 'idle' | 'uploading' | 'complete' | 'error';

interface GroundTruthUploaderProps {
  getToken: () => Promise<string | null>;
  onUploadComplete: (s3Key: string) => void;
  onClear: () => void;
}

export default function GroundTruthUploader({ getToken, onUploadComplete, onClear }: GroundTruthUploaderProps) {
  const [state, setState] = useState<UploadState>('idle');
  const [fileName, setFileName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setErrorMsg('');
    setFileName(file.name);

    if (!file.name.endsWith('.txt')) {
      setState('error');
      setErrorMsg('Only .txt files are accepted for ground truth.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setState('error');
      setErrorMsg('Ground truth file must be under 1 MB.');
      return;
    }

    try {
      setState('uploading');
      const token = await getToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      const { uploadUrl, s3Key } = await requestUploadUrl(token, file.name, file.size, 'text/plain');
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      setState('complete');
      onUploadComplete(s3Key);
    } catch (e) {
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : 'Upload failed');
    }
  }, [getToken, onUploadComplete]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    if (inputRef.current) inputRef.current.value = '';
  }, [handleFile]);

  const handleClear = () => {
    setState('idle');
    setFileName('');
    setErrorMsg('');
    onClear();
  };

  return (
    <div style={s.container}>
      <input
        ref={inputRef}
        type="file"
        accept=".txt,text/plain"
        onChange={onFileChange}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />

      {state === 'idle' && (
        <button type="button" style={s.browseBtn} onClick={() => inputRef.current?.click()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Upload ground truth (.txt)
        </button>
      )}

      {state === 'uploading' && (
        <div style={s.status}>
          <div style={s.spinner} />
          <span style={s.statusText}>Uploading {fileName}…</span>
        </div>
      )}

      {state === 'complete' && (
        <div style={s.completeRow}>
          <div style={s.completeIcon}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span style={s.okText}>{fileName}</span>
          <button type="button" style={s.clearBtn} onClick={handleClear} aria-label="Remove ground truth">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {state === 'error' && (
        <div style={s.errorRow}>
          <span style={s.errText}>{errorMsg}</span>
          <button type="button" style={s.retryBtn} onClick={() => { setState('idle'); setErrorMsg(''); }}>Retry</button>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: {},
  browseBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '9px 16px', borderRadius: 10,
    border: '1px dashed rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.02)',
    color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  status: { display: 'flex', alignItems: 'center', gap: 10 },
  spinner: {
    width: 14, height: 14,
    border: '2px solid rgba(255,255,255,0.06)', borderTopColor: '#6366f1',
    borderRadius: '50%', animation: 'spin 0.8s linear infinite',
  },
  statusText: { fontSize: 13, color: 'rgba(255,255,255,0.4)' },
  completeRow: { display: 'flex', alignItems: 'center', gap: 8 },
  completeIcon: {
    width: 22, height: 22, borderRadius: 6,
    background: 'rgba(52, 211, 153, 0.1)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  okText: { fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.75)' },
  clearBtn: {
    background: 'rgba(255,255,255,0.04)', border: 'none',
    color: 'rgba(255,255,255,0.3)', cursor: 'pointer',
    padding: 4, borderRadius: 6, display: 'inline-flex', alignItems: 'center',
    transition: 'color 0.15s ease',
  },
  errorRow: { display: 'flex', alignItems: 'center', gap: 10 },
  errText: { fontSize: 13, color: '#f87171' },
  retryBtn: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 500,
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
};
