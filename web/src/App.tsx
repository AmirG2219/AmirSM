import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useAuth } from './hooks/auth';
import { BootScreen, LoginScreen, ServerDownScreen, SetupScreen } from './pages/AuthScreens';
import { Library } from './pages/Library';
import { Research } from './pages/Research';
import { Email } from './pages/Email';
import { Settings } from './pages/Settings';
import { Home } from './pages/Home';
import { StudioList } from './pages/studio/StudioList';
import { ProjectPage } from './pages/studio/ProjectPage';
import { PageHeader, EmptyState } from './components/ui';
import { Link } from 'react-router-dom';

function NotFound() {
  return (
    <div className="page page-narrow">
      <PageHeader title="Page not found" />
      <EmptyState icon="search" title="Nothing lives at this address">
        The link may be old or mistyped.{' '}
        <Link to="/">Go back home</Link>.
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
          <Route index element={<Home />} />
          <Route path="studio" element={<StudioList />} />
          <Route path="studio/:id" element={<ProjectPage />} />
          <Route path="library" element={<Library />} />
          <Route path="research" element={<Research />} />
          <Route path="email" element={<Email />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
