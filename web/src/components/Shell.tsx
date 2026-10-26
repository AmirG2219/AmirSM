import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { IconButton } from './ui';
import { Mark, Wordmark } from './Logo';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/auth';
import { useTheme } from '../hooks/theme';
import { safeStorage } from '../hooks/hooks';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}
const MAIN: NavItem[] = [
  { to: '/', label: 'Social Studio', icon: 'studio', end: true },
  { to: '/email', label: 'Email', icon: 'mail' },
];
const SETTINGS: NavItem = { to: '/settings', label: 'Settings', icon: 'settings' };
const ALL = [...MAIN, SETTINGS];
const NAV_KEY = 'amirsm.nav';

export function Shell() {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(NAV_KEY) === 'collapsed');

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const toggleNav = () =>
    setCollapsed((c) => {
      safeStorage.set(NAV_KEY, c ? 'expanded' : 'collapsed');
      return !c;
    });

  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  // The studio owns "/" and "/studio/:id".
  const isActive = (n: NavItem) => (n.to === '/' ? pathname === '/' || pathname.startsWith('/studio') : pathname.startsWith(n.to));

  const link = (n: NavItem, quiet = false) => (
    <NavLink key={n.to} to={n.to} end={n.end} className={`nav-link${quiet ? ' nav-quiet' : ''}`} aria-current={isActive(n) ? 'page' : undefined} aria-label={collapsed ? n.label : undefined} data-label={n.label}>
      <Icon name={n.icon} />
      <span className="nav-label">{n.label}</span>
    </NavLink>
  );

  return (
    <div className={`app${collapsed ? ' app-collapsed' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <button type="button" className="nav-fab" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} aria-controls="sidebar" onClick={toggleNav}>
        <Icon name="sidebar" />
      </button>
      <div className="theme-fab">
        <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={themeLabel} onClick={toggle} />
      </div>
      <aside className="sidebar" id="sidebar" aria-label="Primary">
        <div className="side-top">
          <Link className="brand" to="/" aria-label="Amir SM, Social Studio">
            <Mark />
            <Wordmark />
          </Link>
        </div>
        <nav className="nav" aria-label="Main">
          {MAIN.map((n) => link(n))}
        </nav>
        <div className="sidebar-foot">
          {link(SETTINGS, true)}
          <button type="button" className="nav-link nav-quiet" onClick={() => void logout()} aria-label={collapsed ? 'Sign out' : undefined} data-label="Sign out">
            <Icon name="logout" />
            <span className="nav-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <NavLink to="/" className="brand" aria-label="Amir SM, Social Studio">
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
        {ALL.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="tab-link" aria-current={isActive(n) ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
