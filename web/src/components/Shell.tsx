import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Icon, type IconName } from './Icon';
import { IconButton } from './ui';
import { Brand, Mark, Wordmark } from './Logo';
import { useAuth } from '../hooks/auth';
import { useTheme } from '../hooks/theme';

export const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/studio', label: 'Studio', icon: 'studio' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/research', label: 'Research', icon: 'research' },
  { to: '/email', label: 'Email', icon: 'mail' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export function Shell() {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();

  // Move focus to the main region on navigation so keyboard / screen-reader users land on new content.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Primary">
        <Brand to="/" />
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="nav-link" onClick={toggle} style={{ background: 'none', border: 0, textAlign: 'left', width: '100%' }}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <button type="button" className="nav-link" onClick={() => void logout()} style={{ background: 'none', border: 0, textAlign: 'left', width: '100%' }}>
            <Icon name="logout" />
            Sign out
          </button>
          <p className="sidebar-note">Private workspace. Everything stays on this machine.</p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <NavLink to="/" className="brand" aria-label="Amir SM home">
            <Mark />
            <Wordmark />
          </NavLink>
          <span className="spacer" />
          <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={themeLabel} onClick={toggle} />
          <IconButton icon="logout" label="Sign out" onClick={() => void logout()} />
        </header>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="tab-link">
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
