import type { ReactNode } from 'react';

const P = (d: string) => <path d={d} />;

const ICONS = {
  home: <>{P('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z')}</>,
  studio: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m10 9 5.5 3-5.5 3z" />
    </>
  ),
  library: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  research: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('m15.8 8.2-1.9 5.7-5.7 1.9 1.9-5.7z')}
    </>
  ),
  mail: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      {P('m21.5 7.5-9.5 6-9.5-6')}
    </>
  ),
  settings: (
    <>
      {P('M4 7h8M18 7h2M4 17h2M12 17h8')}
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </>
  ),
  plus: P('M12 5v14M5 12h14'),
  x: P('M18 6 6 18M6 6l12 12'),
  check: P('M20 6 9 17l-5-5'),
  'arrow-left': P('M19 12H5M12 19l-7-7 7-7'),
  'arrow-up': P('M12 19V5M5 12l7-7 7 7'),
  'arrow-down': P('M12 5v14M19 12l-7 7-7-7'),
  'chevron-right': P('m9 18 6-6-6-6'),
  'chevron-down': P('m6 9 6 6 6-6'),
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      {P('m21 21-4.3-4.3')}
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      {P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')}
    </>
  ),
  edit: P('M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z'),
  download: P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'),
  upload: P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'),
  refresh: P('M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5'),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      {P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')}
    </>
  ),
  moon: P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'),
  logout: P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'),
  eye: (
    <>
      {P('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z')}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': P('M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-3.2 4.3M6.6 6.6A16 16 0 0 0 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M14.1 14.1a3 3 0 1 1-4.2-4.2'),
  alert: P('m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3zM12 9v4M12 17h.01'),
  info: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      {P('M12 16v-4M12 8h.01')}
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      {P('M12 6.5V12l3.5 2')}
    </>
  ),
  archive: (
    <>
      <rect x="2.5" y="3.5" width="19" height="5" rx="1.2" />
      {P('M4.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4')}
    </>
  ),
  music: (
    <>
      {P('M9 18V5l11-2v13')}
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      {P('M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4')}
    </>
  ),
  play: P('M7 4.5v15l12-7.5z'),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  'circle-check': (
    <>
      <circle cx="12" cy="12" r="9.5" />
      {P('m8 12.5 3 3 5-6')}
    </>
  ),
  'circle-x': (
    <>
      <circle cx="12" cy="12" r="9.5" />
      {P('m15 9-6 6M9 9l6 6')}
    </>
  ),
  'circle-dash': (
    <>
      <circle cx="12" cy="12" r="9.5" />
      {P('M8.5 12h7')}
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      {P('M8 10.5V7.5a4 4 0 0 1 8 0v3')}
    </>
  ),
  list: P('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01'),
  pulse: P('M3 12h4l3-8 4 16 3-8h4'),
  external: P('M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'),
  trash: P('M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6'),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      {P('M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20')}
    </>
  ),
  note: P('M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM15 3v5h5M8 13h8M8 17h5'),
  globe: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      {P('M2.5 12h19M12 2.5c2.8 3 4 6 4 9.5s-1.2 6.5-4 9.5c-2.8-3-4-6-4-9.5s1.2-6.5 4-9.5z')}
    </>
  ),
  history: P('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2'),
  send: P('m22 2-11 11M22 2l-7 20-4-9-9-4z'),
  inbox: P('M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z'),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      {P('M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3')}
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = '', size }: { name: IconName; className?: string; size?: 'sm' | 'lg' }) {
  return (
    <svg className={`icon ${size === 'sm' ? 'icon-sm' : size === 'lg' ? 'icon-lg' : ''} ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}
