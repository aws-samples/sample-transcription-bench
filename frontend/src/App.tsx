import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import NavBar from './components/NavBar';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import NewJobPage from './pages/NewJobPage';
import ComparisonPage from './pages/ComparisonPage';
import MetricsGuidePage from './pages/MetricsGuidePage';
import { ReactNode } from 'react';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        width: 24, height: 24,
        border: '2px solid rgba(255,255,255,0.06)',
        borderTopColor: '#6366f1',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
    </div>
  );
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppLayout() {
  const location = useLocation();
  const isLogin = location.pathname === '/login';

  return (
    <>
      {!isLogin && <NavBar />}
      <main key={location.pathname} style={{ animation: 'fadeIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) both' }}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/new-job" element={<ProtectedRoute><NewJobPage /></ProtectedRoute>} />
          <Route path="/jobs/:jobId" element={<ProtectedRoute><ComparisonPage /></ProtectedRoute>} />
          <Route path="/metrics-guide" element={<ProtectedRoute><MetricsGuidePage /></ProtectedRoute>} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppLayout />
      </AuthProvider>
    </BrowserRouter>
  );
}
