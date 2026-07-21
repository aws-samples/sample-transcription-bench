import React, { useCallback, useRef, useState } from 'react';
import { requestUploadUrl } from '../services/api';

// WAV is the only format we currently support end-to-end. Other containers
// (MP3 / FLAC / OGG / M4A) need per-model handling on the SageMaker / Bedrock
// side that we haven't validated yet, so we reject them up-front.
const ACCEPTED_EXTENSIONS = ['.wav'] as const;
const MAX_FILE_SIZE = 524_288_000;
const MIME_MAP: Record<string, string> = { '.wav': 'audio/wav' };
const ACCEPTED_MIMES = new Set(Object.values(MIME_MAP));

type UploadState = 'idle' | 'validating' | 'uploading' | 'complete' | 'error';

interface AudioUploaderProps {
  onUploadComplete: (s3Key: string) => void;
  getToken: () => Promise<string | null>;
}

export function getExtension(name: string): string { const idx = name.lastIndexOf('.'); return idx >= 0 ? name.slice(idx).toLowerCase() : ''; }

export function validateFile(file: File): string | null {
  const ext = getExtension(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext as typeof ACCEPTED_EXTENSIONS[number])) return `Unsupported format "${ext || '(none)'}". Only WAV is supported.`;
  const expectedMime = MIME_MAP[ext];
  if (expectedMime && file.type && !ACCEPTED_MIMES.has(file.type)) return `Invalid MIME type "${file.type}".`;
  if (file.size > MAX_FILE_SIZE) return `File too large (${(file.size / 1_048_576).toFixed(1)} MB). Max 500 MB.`;
  return null;
}

export default function AudioUploader({ onUploadComplete, getToken }: AudioUploaderProps) {
  const [state, setState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setState('validating'); setErrorMsg(''); setFileName(file.name);
    const err = validateFile(file);
    if (err) { setState('error'); setErrorMsg(err); return; }
    try {
      setState('uploading'); setProgress(0);
      const ext = getExtension(file.name);
      const contentType = MIME_MAP[ext] ?? file.type;
      const token = await getToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      const { uploadUrl, s3Key } = await requestUploadUrl(token, file.name, file.size, contentType);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); });
        xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`)));
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.send(file);
      });
      setState('complete'); setProgress(100); onUploadComplete(s3Key);
    } catch (e) { setState('error'); setErrorMsg(e instanceof Error ? e.message : 'Upload failed'); }
  }, [getToken, onUploadComplete]);

  const onDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }, [handleFile]);
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) handleFile(f); if (inputRef.current) inputRef.current.value = ''; }, [handleFile]);
  const acceptAttr = ACCEPTED_EXTENSIONS.map((ext) => `${ext},${MIME_MAP[ext]}`).join(',');

  return (
    <div
      role="button" tabIndex={0} aria-label="Drop audio file here or click to browse"
      onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      style={{ ...s.drop, ...(dragOver ? s.dropActive : {}), ...(state === 'error' ? s.dropErr : {}), ...(state === 'complete' ? s.dropOk : {}) }}>
      <input ref={inputRef} type="file" accept={acceptAttr} onChange={onFileChange} style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />

      {state === 'idle' && (
        <div style={s.idleContent}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" style={{ marginBottom: 10 }} aria-hidden="true">
            <path d="M12 16V8m0 0l-3 3m3-3l3 3M21 15v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p style={s.text}>Drag & drop an audio file, or <span style={s.link}>browse</span></p>
          <p style={s.hint}>WAV — up to 500 MB</p>
        </div>
      )}
      {state === 'validating' && <p style={s.text}>Validating…</p>}
      {state === 'uploading' && (
        <div style={{ width: '100%' }}>
          <p style={s.text}>Uploading {fileName}… {progress}%</p>
          <div style={s.bar}><div style={{ ...s.barFill, width: `${progress}%` }} /></div>
        </div>
      )}
      {state === 'complete' && (
        <p style={s.okText}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {fileName} uploaded
        </p>
      )}
      {state === 'error' && <p style={s.errText}>{errorMsg}</p>}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  drop: {
    border: '1.5px dashed rgba(255,255,255,0.1)', borderRadius: 14,
    padding: '32px 20px', textAlign: 'center', cursor: 'pointer',
    transition: 'border-color 0.25s cubic-bezier(0.22, 1, 0.36, 1), background 0.25s ease',
    background: 'rgba(0,0,0,0.15)',
  },
  dropActive: { borderColor: 'rgba(99,102,241,0.6)', background: 'rgba(99,102,241,0.04)' },
  dropErr: { borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.03)' },
  dropOk: { borderColor: 'rgba(52,211,153,0.4)', background: 'rgba(52,211,153,0.03)' },
  idleContent: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center' },
  text: { margin: 0, color: 'rgba(255,255,255,0.45)', fontSize: 13, lineHeight: 1.6 },
  hint: { margin: '6px 0 0', fontSize: 11, color: 'rgba(255,255,255,0.2)' },
  link: { color: '#818cf8', cursor: 'pointer' },
  okText: { margin: 0, color: '#34d399', fontWeight: 500, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  errText: { margin: 0, color: '#f87171', fontSize: 13 },
  bar: { marginTop: 12, height: 4, borderRadius: 100, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' },
  barFill: { height: '100%', background: 'linear-gradient(90deg, #6366f1, #818cf8)', borderRadius: 100, transition: 'width 0.3s cubic-bezier(0.22, 1, 0.36, 1)' },
};
