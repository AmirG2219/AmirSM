/**
 * Provider presets. Hosts/ports are the providers' published IMAP/SMTP endpoints. How each provider currently treats
 * password logins was researched on 2026-10-26 from vendor/community pages, NOT verified against a live mailbox — see
 * docs/EMAIL.md "Unverified assumptions". Providers that need OAuth are listed with supported:false and a reason;
 * nothing pretends to work.
 */
import type { EmailProviderPreset } from '../../../shared/api.js';

export const PRESETS: EmailProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    supported: true,
    unsupportedReason: null,
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    passwordKind: 'app_password',
    autoSavesSent: true,
    steps: [
      'Turn on 2-Step Verification for your Google account (Security settings).',
      'Open myaccount.google.com/apppasswords, name it "Amir SM" and create the app password.',
      'Paste the 16-character app password here (not your normal Google password).',
    ],
    helpUrl: 'https://support.google.com/accounts/answer/185833',
    notes: 'Google Workspace admins can switch app passwords off; if the option is missing, your organisation blocks it. Gmail threads are grouped with Google\'s own thread ids.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    supported: true,
    unsupportedReason: null,
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    passwordKind: 'app_password',
    autoSavesSent: false,
    steps: [
      'Sign in at account.apple.com and open Sign-In and Security > App-Specific Passwords.',
      'Create one named "Amir SM" and copy it (format xxxx-xxxx-xxxx-xxxx).',
      'Paste it here. Use your full iCloud address; if login fails, try only the part before the @ as the username.',
    ],
    helpUrl: 'https://support.apple.com/102525',
    notes: null,
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    supported: true,
    unsupportedReason: null,
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    passwordKind: 'app_password',
    autoSavesSent: true,
    steps: [
      'Sign in to Yahoo, open Account Info > Account security.',
      'Choose "Generate app password", name it "Amir SM", and copy the password.',
      'Paste it here (not your normal Yahoo password).',
    ],
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    notes: null,
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    supported: true,
    unsupportedReason: null,
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    passwordKind: 'app_password',
    autoSavesSent: false,
    steps: [
      'In Fastmail open Settings > Privacy & Security > Integrations > New app password.',
      'Name it "Amir SM" and give it access to "Mail (IMAP/POP/SMTP)".',
      'Paste the generated password here (not your normal Fastmail password).',
    ],
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
    notes: null,
  },
  {
    id: 'protonbridge',
    label: 'Proton Mail (via Proton Bridge on this computer)',
    supported: true,
    unsupportedReason: null,
    imap: { host: '127.0.0.1', port: 1143, security: 'starttls' },
    smtp: { host: '127.0.0.1', port: 1025, security: 'starttls' },
    passwordKind: 'bridge_password',
    autoSavesSent: true,
    steps: [
      'Install and sign in to Proton Mail Bridge (paid Proton plan) and keep it running.',
      'In Bridge open your account > "Mailbox configuration" and copy the Bridge username and password.',
      'Use your Proton address and the Bridge password here. Bridge uses a self-signed local certificate, which is accepted for this computer only.',
    ],
    helpUrl: 'https://proton.me/support/protonmail-bridge-install',
    notes: 'Ports are the Bridge defaults (IMAP 1143, SMTP 1025); use "Other" if yours differ.',
  },
  {
    id: 'outlook',
    label: 'Outlook.com / Hotmail / Microsoft 365',
    supported: false,
    unsupportedReason: 'Needs Microsoft OAuth sign-in (password and app-password logins over IMAP/SMTP are no longer accepted), which is not implemented yet.',
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    passwordKind: 'account_password',
    autoSavesSent: true,
    steps: [],
    helpUrl: null,
    notes: 'A Microsoft Graph / OAuth provider can be added later behind the same provider interface.',
  },
  {
    id: 'custom',
    label: 'Other (IMAP + SMTP)',
    supported: true,
    unsupportedReason: null,
    imap: null,
    smtp: null,
    passwordKind: 'account_password',
    autoSavesSent: false,
    steps: [
      'Find the IMAP and SMTP server names, ports and security in your provider\'s help pages.',
      'Use an app-specific password if your provider offers one.',
      'Choose "TLS" for ports 993/465 and "STARTTLS" for 143/587. Unencrypted is only allowed for servers on this computer.',
    ],
    helpUrl: null,
    notes: 'Local bridges (127.0.0.1 / localhost) are allowed and may use a self-signed certificate.',
  },
];

export function findPreset(id: string): EmailProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
