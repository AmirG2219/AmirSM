import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useAuth } from './hooks/auth';
import { BootScreen, LoginScreen, ServerDownScreen, SetupScreen } from './pages/AuthScreens';
import { Placeholder } from './pages/Placeholder';
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
          <Route
            path="library"
            element={<Placeholder title="Library" icon="library" lede="Every clip, draft and approved export, in one searchable place.">Browsing and searching your uploaded clips, drafts and exports arrives in phase 2. Everything you upload in Social Studio is already preserved on disk.</Placeholder>}
          />
          <Route
            path="research"
            element={<Placeholder title="Research" icon="research" lede="Competitor notes, ideas and market research.">Competitor tracking, notes and analysis of material you paste in arrive in phase 2.</Placeholder>}
          />
          <Route
            path="email"
            element={<Placeholder title="Email" icon="mail" lede="Read, summarise and draft replies, with your approval before anything is sent.">The inbox, summaries and approval-gated drafts arrive in phase 2.</Placeholder>}
          />
          <Route
            path="settings"
            element={<Placeholder title="Settings" icon="settings" lede="Integrations, AI usage and storage.">Integration status, AI usage limits and storage details arrive in phase 2. The Home page already shows live system status.</Placeholder>}
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
