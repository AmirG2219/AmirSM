import { useMemo, useState } from 'react';
import type { EmailAccountDTO, EmailConnectInput, EmailConnectionTestResult, EmailEndpoint, EmailProviderPreset, EmailSecurity } from '@shared/api';
import { api } from '../../api/client';
import { Button, Callout, Input, Select, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useAsync } from '../../hooks/hooks';
import { parseAddress } from './util';

type Step = 'provider' | 'steps' | 'details';

const PASSWORD_LABEL: Record<EmailProviderPreset['passwordKind'], string> = {
  app_password: 'App password',
  bridge_password: 'Bridge password',
  account_password: 'Account password',
};

const CUSTOM: EmailProviderPreset = {
  id: 'custom',
  label: 'Other (IMAP and SMTP)',
  supported: true,
  unsupportedReason: null,
  imap: null,
  smtp: null,
  passwordKind: 'app_password',
  autoSavesSent: false,
  steps: ['Find your provider’s IMAP and SMTP server names, ports and security settings.', 'Create an app password if your provider offers one; otherwise use your account password.'],
  helpUrl: null,
  notes: 'For providers not listed. For Proton Mail, run Proton Bridge on this computer and use the localhost settings it shows.',
};

export function ConnectFlow({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: (a: EmailAccountDTO) => void }) {
  const toast = useToast();
  const providers = useAsync((s) => (open ? api.email.providers(s) : Promise.resolve([] as EmailProviderPreset[])), [open]);
  const [step, setStep] = useState<Step>('provider');
  const [preset, setPreset] = useState<EmailProviderPreset | null>(null);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapSec, setImapSec] = useState<EmailSecurity>('tls');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpSec, setSmtpSec] = useState<EmailSecurity>('tls');
  const [selfSigned, setSelfSigned] = useState(false);
  const [autoSent, setAutoSent] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState<{ key: string; r: EmailConnectionTestResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    const l = providers.data ?? [];
    return l.some((p) => p.id === 'custom') ? l : [...l, CUSTOM];
  }, [providers.data]);

  const isCustom = preset?.id === 'custom';
  const isLocal = (h: string) => /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(h.trim());

  const buildInput = (): EmailConnectInput | null => {
    if (!preset) return null;
    const addr = parseAddress(address);
    if (!addr || !password) return null;
    const base: EmailConnectInput = { presetId: preset.id, address: addr, password };
    if (username.trim()) base.username = username.trim();
    if (isCustom) {
      const ip = Number(imapPort);
      const sp = Number(smtpPort);
      if (!imapHost.trim() || !smtpHost.trim() || !Number.isInteger(ip) || !Number.isInteger(sp)) return null;
      const imap: EmailEndpoint = { host: imapHost.trim(), port: ip, security: imapSec };
      const smtp: EmailEndpoint = { host: smtpHost.trim(), port: sp, security: smtpSec };
      base.imap = imap;
      base.smtp = smtp;
      base.autoSavesSent = autoSent;
      if (selfSigned && isLocal(imap.host) && isLocal(smtp.host)) base.allowSelfSigned = true;
    }
    return base;
  };
  const input = buildInput();
  // The password is part of the key only to invalidate a previous test when it changes; it is never rendered or stored.
  const key = JSON.stringify(input);
  const tested = result && result.key === key ? result.r : null;

  const reset = () => {
    setStep('provider');
    setPreset(null);
    setAddress('');
    setPassword('');
    setUsername('');
    setAdvanced(false);
    setResult(null);
    setError(null);
    setSelfSigned(false);
  };
  const close = () => {
    if (testing || connecting) return;
    reset();
    onClose();
  };

  const test = async () => {
    if (!input) return;
    setTesting(true);
    setError(null);
    try {
      setResult({ key, r: await api.email.testConnection(input) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    if (!input) return;
    setConnecting(true);
    setError(null);
    try {
      const acc = await api.email.connect(input);
      toast.success('Mailbox connected', 'Syncing your mail now. This can take a minute.');
      reset();
      onConnected(acc);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const protoRow = (label: string, t: { ok: boolean; message: string | null }) => (
    <li className={t.ok ? 'proto-ok' : 'proto-bad'}>
      <Icon name={t.ok ? 'circle-check' : 'circle-x'} />
      <div>
        <div style={{ fontWeight: 600 }}>{label}: {t.ok ? 'working' : 'failed'}</div>
        {t.message ? <div className="small">{t.message}</div> : null}
      </div>
    </li>
  );

  let footer;
  if (step === 'provider') {
    footer = <Button variant="quiet" onClick={close}>Cancel</Button>;
  } else if (step === 'steps') {
    footer = (
      <>
        <Button variant="quiet" onClick={() => setStep('provider')}>Back</Button>
        <Button variant="primary" onClick={() => setStep('details')}>I have it, continue</Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="quiet" onClick={() => setStep(isCustom ? 'provider' : 'steps')} disabled={testing || connecting}>Back</Button>
        <Button busy={testing} disabled={!input || connecting} onClick={() => void test()}>Test connection</Button>
        <Button variant="primary" busy={connecting} disabled={!tested?.ok || testing} onClick={() => void connect()} title={!tested?.ok ? 'Test the connection first' : undefined}>Connect</Button>
      </>
    );
  }

  return (
    <Modal open={open} onClose={close} locked={testing || connecting} title="Connect your mailbox" footer={footer}>
      <div className="connect stack">
        {step === 'provider' ? (
          <>
            <p className="muted">Choose where your email lives. You will use an app password, never your main login, and it is stored encrypted on this computer.</p>
            {providers.error && !providers.data ? (
              <Callout tone="err" title="Could not load providers">{providers.error.message}</Callout>
            ) : providers.loading && !providers.data ? (
              <Skeleton h={120} />
            ) : (
              <ul className="ptiles">
                {list.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="ptile" disabled={!p.supported} onClick={() => { setPreset(p); setStep(p.id === 'custom' ? 'details' : 'steps'); setResult(null); setError(null); }}>
                      <span className="ptile-mark" aria-hidden="true">{p.label.slice(0, 1).toUpperCase()}</span>
                      <span className="ptile-main">
                        <span className="ptile-name">{p.label}</span>
                        <span className="ptile-sub">{p.supported ? (p.id === 'custom' ? 'Any IMAP and SMTP server' : PASSWORD_LABEL[p.passwordKind]) : p.unsupportedReason ?? 'Not supported'}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {step === 'steps' && preset ? (
          <>
            <h3 className="connect-h">Get your {PASSWORD_LABEL[preset.passwordKind].toLowerCase()} for {preset.label}</h3>
            <ol className="steplist">
              {preset.steps.map((s, i) => (
                <li key={i}><span className="steplist-n">{i + 1}</span><span>{s}</span></li>
              ))}
            </ol>
            {preset.notes ? <Callout tone="info">{preset.notes}</Callout> : null}
            {preset.helpUrl && /^https:\/\//i.test(preset.helpUrl) ? (
              <p className="small">
                <a href={preset.helpUrl} target="_blank" rel="noopener noreferrer">Open {preset.label}’s help page <Icon name="link" size="sm" /></a>
                <span className="sr-only"> (opens in a new tab)</span>
              </p>
            ) : null}
          </>
        ) : null}

        {step === 'details' && preset ? (
          <>
            <h3 className="connect-h">{preset.label}</h3>
            {isCustom ? (
              <div className="custom-grid">
                <Input label="IMAP server (incoming)" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="imap.example.com" autoComplete="off" />
                <Input label="Port" value={imapPort} onChange={(e) => setImapPort(e.target.value)} inputMode="numeric" autoComplete="off" />
                <Select label="Security" value={imapSec} onChange={(e) => setImapSec(e.target.value as EmailSecurity)}>
                  <option value="tls">TLS (SSL)</option>
                  <option value="starttls">STARTTLS</option>
                  <option value="none">None</option>
                </Select>
                <Input label="SMTP server (outgoing)" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" />
                <Input label="Port" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} inputMode="numeric" autoComplete="off" />
                <Select label="Security" value={smtpSec} onChange={(e) => setSmtpSec(e.target.value as EmailSecurity)}>
                  <option value="tls">TLS (SSL)</option>
                  <option value="starttls">STARTTLS</option>
                  <option value="none">None</option>
                </Select>
              </div>
            ) : null}
            <Input label="Email address" type="email" inputMode="email" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" placeholder="you@example.com" error={address && !parseAddress(address) ? 'Enter a full email address.' : undefined} />
            <Input label={PASSWORD_LABEL[preset.passwordKind]} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" hint="Stored encrypted on this computer. It is never shown again." />
            <button type="button" className="linkbtn" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              {advanced ? 'Hide' : 'Show'} advanced options
            </button>
            {advanced ? (
              <div className="stack">
                <Input label="Login name" optional value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" hint="Only if your login is different from your email address." />
                {isCustom ? (
                  <>
                    <label className="check"><input type="checkbox" checked={autoSent} onChange={(e) => setAutoSent(e.target.checked)} /> My provider already files sent mail in Sent</label>
                    {isLocal(imapHost) && isLocal(smtpHost) ? (
                      <label className="check"><input type="checkbox" checked={selfSigned} onChange={(e) => setSelfSigned(e.target.checked)} /> Trust this local server’s certificate (Proton Bridge)</label>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {tested ? (
              <div className="testbox" role="status" aria-live="polite">
                <ul className="stack-s">
                  {protoRow('Receiving mail (IMAP)', tested.imap)}
                  {protoRow('Sending mail (SMTP)', tested.smtp)}
                </ul>
                {tested.ok ? <p className="small muted" style={{ margin: '8px 0 0' }}>Looks good.{tested.sentFolder ? ` Sent mail will be filed in “${tested.sentFolder}”.` : ''} Press Connect to finish.</p> : <p className="small" style={{ margin: '8px 0 0' }}>Fix the problem above and test again.</p>}
              </div>
            ) : null}
            {error ? <Callout tone="err" title="That did not work">{error}</Callout> : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
