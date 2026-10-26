import type { ReactNode } from 'react';

const P = (d: string) => <path d={d} />;

const ICONS = {
  studio: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m10 9 5.5 3-5.5 3z" />
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
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      {P('M9 4v16')}
    </>
  ),
  paperclip: P('m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.7 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9'),
  'chevron-down': P('m6 9 6 6 6-6'),
  'chevron-up': P('m18 15-6-6-6 6'),
  reply: P('M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3'),
  link: P('M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7'),
  more: P('M5 12h.01M12 12h.01M19 12h.01'),
  'arrow-right': P('M5 12h14M12 5l7 7-7 7'),
  'arrow-up': P('M12 19V5M5 12l7-7 7 7'),
  'arrow-down': P('M12 5v14M19 12l-7 7-7-7'),
  'chevron-right': P('m9 18 6-6-6-6'),
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
  list: P('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01'),
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
