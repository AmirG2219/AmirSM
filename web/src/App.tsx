import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { EmptyState, PageHeader } from './components/ui';
import { useAuth } from './hooks/auth';
import { BootScreen, LoginScreen, ServerDownScreen, SetupScreen } from './pages/AuthScreens';
import { Email } from './pages/email/Email';
import { Settings } from './pages/Settings';
import { StudioHome } from './pages/studio/StudioHome';
import { Workspace } from './pages/studio/Workspace';

function NotFound() {
  return (
    <div className="page page-narrow">
      <PageHeader title="Page not found" />
      <EmptyState icon="search" title="Nothing lives at this address">
        The link may be old or mistyped. <Link to="/">Go to Social Studio</Link>.
      </EmptyState>
    </div>
  );
}

export default function App() {
  const { status, error } = useAuth();
  if (status === 'loading') return <BootScreen />;
  if (status === 'error') return <ServerDownScreen message={error} />;
  if (status === 'setup') return <SetupScreen />;
  if (status === 'login') return <LoginScreen />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<StudioHome />} />
          <Route path="studio" element={<Navigate to="/" replace />} />
          <Route path="studio/:id" element={<Workspace />} />
          <Route path="email" element={<Email />} />
          <Route path="settings" element={<Settings />} />
          {/* Retired pages: send old bookmarks somewhere sensible. */}
          <Route path="library" element={<Navigate to="/" replace />} />
          <Route path="research" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
