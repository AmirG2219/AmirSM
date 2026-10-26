import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { Button, Card, Input, Callout } from '../components/ui';
import { IconButton } from '../components/ui';
import { Mark, Wordmark } from '../components/Logo';
import { useAuth } from '../hooks/auth';
import { useTheme } from '../hooks/theme';
import { useDocumentTitle } from '../hooks/hooks';

const MIN = 10;

function AuthFrame({ children }: { children: React.ReactNode }) {
  const { theme, toggle } = useTheme();
  return (
    <main className="auth">
      <div className="auth-theme">
        <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle} />
      </div>
      <Card className="auth-card">
        <div className="brand">
          <Mark large />
          <Wordmark />
        </div>
        {children}
      </Card>
    </main>
  );
}

export function SetupScreen() {
  useDocumentTitle('Set your password');
  const { refresh } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const tooShort = pw.length < MIN;
  const mismatch = pw !== pw2;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (tooShort || mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.setup(pw);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the password.');
      if (err instanceof ApiError && err.code === 'already_setup') await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <h1>Set your password</h1>
      <p className="muted">
        This workspace is private to you. Choose a password to protect it; you will use it to sign in on this device. There are no other accounts and nothing is sent to a cloud service.
      </p>
      <form onSubmit={submit} className="stack" style={{ marginTop: 'var(--s-5)' }} noValidate>
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          hint={`At least ${MIN} characters. A few random words works well.`}
          error={touched && tooShort ? `Use at least ${MIN} characters (${pw.length} so far).` : undefined}
          autoFocus
          required
        />
        <Input
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          error={touched && !tooShort && mismatch ? 'The two passwords do not match.' : undefined}
          required
        />
        {error ? <Callout tone="err">{error}</Callout> : null}
        <Button type="submit" variant="primary" size="lg" busy={busy} block>
          Create password and continue
        </Button>
        <p className="tiny faint">Forgotten passwords cannot be recovered from the app. They are stored only as a salted hash on this machine.</p>
      </form>
    </AuthFrame>
  );
}

export function LoginScreen() {
  useDocumentTitle('Sign in');
  const { refresh } = useAuth();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; throttled: boolean } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.login(pw);
      setPw('');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError({ message: err.message, throttled: err.status === 429 });
      else setError({ message: 'Could not sign in.', throttled: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <h1>Sign in</h1>
      <p className="muted">Welcome back. Enter your password to open your workspace.</p>
      <form onSubmit={submit} className="stack" style={{ marginTop: 'var(--s-5)' }}>
        <Input label="Password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus required />
        {error ? (
          <Callout tone={error.throttled ? 'warn' : 'err'} title={error.throttled ? 'Please wait a moment' : undefined}>
            {error.message}
          </Callout>
        ) : null}
        <Button type="submit" variant="primary" size="lg" busy={busy} block disabled={!pw}>
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}

export function ServerDownScreen({ message }: { message: string | null }) {
  useDocumentTitle('Cannot reach server');
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame>
      <h1>Can’t reach the server</h1>
      <p className="muted">{message ?? 'The Amir SM server did not respond.'}</p>
      <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
        <p className="small muted">
          Start it with <span className="mono">npm run dev</span> (or <span className="mono">npm start</span>) from the project folder, then retry.
        </p>
        <Button
          variant="primary"
          icon="refresh"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await refresh();
            setBusy(false);
          }}
        >
          Try again
        </Button>
      </div>
    </AuthFrame>
  );
}

export function BootScreen() {
  return (
    <main className="auth" aria-busy="true">
      <div role="status" aria-label="Loading Amir SM" style={{ display: 'grid', placeItems: 'center', gap: 16 }}>
        <Mark large />
        <span className="spinner" aria-hidden="true" style={{ color: 'var(--ink-3)' }} />
      </div>
    </main>
  );
}
