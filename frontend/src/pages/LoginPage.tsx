import { useEffect, useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { isAuthenticated, isLoading, signIn } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  const isDisabled = email.trim() === '' || password.trim() === '' || isSubmitting;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isDisabled) return;

    setErrorMessage(null);
    setIsSubmitting(true);

    const result = await signIn(email, password);

    if (result.kind === 'success') {
      navigate('/dashboard', { replace: true });
      return;
    }

    setErrorMessage(result.message);
    setIsSubmitting(false);
  };

  return (
    <div style={styles.wrapper}>
      {/* Ambient glow */}
      <div style={styles.glow} />

      <div style={styles.card} className="login-container responsive-container animate-in-scale">
        <div style={styles.logoSection}>
          <div style={styles.logoIcon}>
            <svg width="44" height="44" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="loginLogoGrad" x1="0" y1="0" x2="40" y2="40">
                  <stop offset="0%" stopColor="#a78bfa" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <rect width="40" height="40" rx="10" fill="url(#loginLogoGrad)" />
              <path d="M12 20c0-1.5 1-3 3-3s3 1.5 3 3M17 16v8M22 20c0-1.5 1-3 3-3s3 1.5 3 3M27 14v12M10 20h2M28 20h2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h1 style={styles.title}>TranscribeBench</h1>
          <p style={styles.subtitle}>
            Compare transcription models side by side
          </p>
        </div>

        <form onSubmit={handleSubmit} style={styles.form} noValidate>
          <label style={styles.label} htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isSubmitting}
            style={styles.input}
            placeholder="you@example.com"
          />

          <label style={styles.label} htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isSubmitting}
            style={styles.input}
            placeholder="••••••••"
          />

          {errorMessage && (
            <div role="alert" style={styles.errorBox}>
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={isDisabled}
            style={{
              ...styles.primaryBtn,
              ...(isDisabled ? styles.primaryBtnDisabled : null),
            }}
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p style={styles.footer}>
          Powered by Amazon Bedrock, SageMaker &amp; Transcribe
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#000',
    padding: 16,
    position: 'relative',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: '30%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 600,
    height: 600,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(99, 102, 241, 0.12) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    background: 'rgba(28, 28, 30, 0.8)',
    backdropFilter: 'blur(40px) saturate(1.5)',
    WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
    borderRadius: 20,
    padding: '44px 36px 36px',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.1) inset',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    textAlign: 'center' as const,
    position: 'relative' as const,
  },
  logoSection: {
    marginBottom: 36,
  },
  logoIcon: {
    display: 'inline-block',
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: 600,
    color: 'rgba(255, 255, 255, 0.95)',
    margin: '0 0 6px',
    letterSpacing: '-0.03em',
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.4)',
    margin: 0,
    fontWeight: 400,
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    textAlign: 'left' as const,
    marginBottom: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: 'rgba(255, 255, 255, 0.5)',
    marginTop: 12,
    marginBottom: 4,
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(0, 0, 0, 0.3)',
    color: 'rgba(255, 255, 255, 0.92)',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
  errorBox: {
    marginTop: 12,
    padding: '10px 14px',
    borderRadius: 10,
    background: 'rgba(248, 113, 113, 0.08)',
    border: '1px solid rgba(248, 113, 113, 0.2)',
    color: '#fca5a5',
    fontSize: 13,
    textAlign: 'left' as const,
  },
  primaryBtn: {
    width: '100%',
    padding: '13px 0',
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease',
    marginTop: 20,
    letterSpacing: '-0.01em',
  },
  primaryBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
    transform: 'none',
  },
  footer: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.2)',
    marginTop: 28,
    marginBottom: 0,
    letterSpacing: '0.01em',
  },
};
