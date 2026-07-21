import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut, user } = useAuth();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <nav style={s.nav}>
      <div style={s.inner}>
        <div style={s.left}>
          <button type="button" onClick={() => navigate('/dashboard')} style={s.logo}>
            <svg width="28" height="28" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="40" y2="40">
                  <stop offset="0%" stopColor="#818cf8" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <rect width="40" height="40" rx="10" fill="url(#logoGrad)" />
              <path d="M12 20c0-1.5 1-3 3-3s3 1.5 3 3M17 16v8M22 20c0-1.5 1-3 3-3s3 1.5 3 3M27 14v12M10 20h2M28 20h2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span style={s.logoText}>TranscribeBench</span>
          </button>
          <div style={s.navLinks}>
            <button type="button" onClick={() => navigate('/dashboard')}
              style={{ ...s.link, ...(isActive('/dashboard') ? s.linkActive : {}) }}>
              Dashboard
            </button>
            <button type="button" onClick={() => navigate('/new-job')}
              style={{ ...s.link, ...(isActive('/new-job') ? s.linkActive : {}) }}>
              New Comparison
            </button>
            <button type="button" onClick={() => navigate('/metrics-guide')}
              style={{ ...s.link, ...(isActive('/metrics-guide') ? s.linkActive : {}) }}>
              Metrics Guide
            </button>
          </div>
        </div>
        <div style={s.right}>
          <span style={s.email}>{user?.displayName}</span>
          <button type="button" onClick={handleSignOut} style={s.signOut}>Sign Out</button>
        </div>
      </div>
    </nav>
  );
}

const s: Record<string, React.CSSProperties> = {
  nav: {
    background: 'rgba(28, 28, 30, 0.72)',
    backdropFilter: 'blur(20px) saturate(1.8)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    position: 'sticky',
    top: 0,
    zIndex: 50,
  },
  inner: {
    maxWidth: 1200,
    margin: '0 auto',
    padding: '0 24px',
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: { display: 'flex', alignItems: 'center', gap: 32 },
  navLinks: { display: 'flex', alignItems: 'center', gap: 4 },
  right: { display: 'flex', alignItems: 'center', gap: 16 },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    transition: 'opacity 0.2s ease',
  },
  logoText: {
    fontSize: 15,
    fontWeight: 600,
    color: 'rgba(255, 255, 255, 0.92)',
    letterSpacing: '-0.02em',
  },
  link: {
    background: 'none',
    border: 'none',
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 8,
    transition: 'color 0.2s ease, background 0.2s ease',
  },
  linkActive: {
    color: 'rgba(255, 255, 255, 0.92)',
    background: 'rgba(255, 255, 255, 0.06)',
  },
  email: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.55)',
    fontWeight: 400,
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  signOut: {
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: 500,
    padding: '5px 12px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
};
