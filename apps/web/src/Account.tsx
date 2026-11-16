import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, type User } from './api.ts';
import { Link } from './router.tsx';
import { Avatar, prepareAvatar } from './Avatar.tsx';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');

export function AccountPage({ user, onUserChange }: { user: User; onUserChange: (u: User) => void }) {
  return (
    <main className="page">
      <Link to="/" className="small">
        ← Home
      </Link>
      <AvatarCard user={user} onUserChange={onUserChange} />
      <TwoFactorCard />
      <PasswordCard />
    </main>
  );
}

function AvatarCard({ user, onUserChange }: { user: User; onUserChange: (u: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const { avatarUrl } = await api.uploadAvatar(await prepareAvatar(file));
      onUserChange({ ...user, avatarUrl });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.deleteAvatar();
      onUserChange({ ...user, avatarUrl: null });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Avatar</h2>
      <div className="avatar-edit">
        <Avatar name={user.displayName} url={user.avatarUrl} seed={user.id} size={88} />
        <div className="stack">
          <label className="file-label">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <span>{busy ? 'Uploading…' : user.avatarUrl ? 'Change picture' : 'Upload picture'}</span>
          </label>
          {user.avatarUrl && (
            <button className="link" onClick={remove} disabled={busy}>
              Remove picture
            </button>
          )}
        </div>
      </div>
      <p className="muted small">It's cropped to a square. Friends and people in your Tanks see it.</p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

type Stage =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'scan'; secret: string; qr: string }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'on'; left: number };

function TwoFactorCard() {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const refresh = () =>
    api.security().then(
      (s) => setStage(s.totpEnabled ? { kind: 'on', left: s.recoveryCodesLeft } : { kind: 'off' }),
      () => setStage({ kind: 'off' }),
    );
  useEffect(() => {
    refresh();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const start = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const { secret, otpauthUrl } = await api.setup2fa(password);
      const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 200 });
      setPassword('');
      setStage({ kind: 'scan', secret, qr });
    });
  };

  const confirmCode = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const { recoveryCodes } = await api.enable2fa(code.trim());
      setCode('');
      setStage({ kind: 'codes', codes: recoveryCodes });
    });
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api.disable2fa(password, code.trim());
      setPassword('');
      setCode('');
      setDisabling(false);
      await refresh();
    });
  };

  return (
    <section className="card">
      <h2>Two-factor login</h2>
      {stage.kind === 'loading' && <p className="muted">Loading…</p>}

      {stage.kind === 'off' && (
        <>
          <p className="muted">
            Ask for a 6-digit code from an authenticator app (Google Authenticator, Aegis, 1Password, …) when you log in. Recommended,
            since FishTank is on the internet.
          </p>
          <form onSubmit={start} className="row">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" required />
            <button className="primary" disabled={busy}>
              Set up
            </button>
          </form>
        </>
      )}

      {stage.kind === 'scan' && (
        <form onSubmit={confirmCode} className="stack">
          <p>Scan this with your authenticator app, then enter the code it shows.</p>
          <img src={stage.qr} alt="QR code for your authenticator app" width={200} height={200} className="qr" />
          <p className="muted small">
            Can't scan? Enter this key manually: <span className="mono">{stage.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
          </p>
          <div className="row">
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required className="mono" />
            <button className="primary" disabled={busy || code.length !== 6}>
              Turn on
            </button>
          </div>
        </form>
      )}

      {stage.kind === 'codes' && (
        <div className="stack">
          <p className="ok">Two-factor login is on.</p>
          <p>
            Save these <strong>recovery codes</strong> somewhere safe. Each one works once if you lose your phone. They won't be shown again.
          </p>
          <ul className="recovery mono">
            {stage.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="row">
            <button onClick={() => navigator.clipboard.writeText(stage.codes.join('\n'))}>Copy codes</button>
            <button className="primary" onClick={refresh}>
              I saved them
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'on' && (
        <>
          <p>
            <span className="ok">On.</span> <span className="muted">{stage.left} recovery codes left.</span>
          </p>
          {!disabling ? (
            <button onClick={() => setDisabling(true)}>Turn off…</button>
          ) : (
            <form onSubmit={disable} className="stack">
              <label>
                Password
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </label>
              <label>
                Authenticator or recovery code
                <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required className="mono" />
              </label>
              <div className="row">
                <button type="button" onClick={() => setDisabling(false)}>
                  Cancel
                </button>
                <button className="danger-btn" disabled={busy}>
                  Turn off two-factor login
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function PasswordCard() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) return setStatus({ kind: 'error', text: 'New passwords do not match' });
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.changePassword(form.current, form.next);
      setForm({ current: '', next: '', confirm: '' });
      setStatus({
        kind: 'ok',
        text: r.signedOutSessions > 0 ? `Password changed. Signed out ${r.signedOutSessions} other session(s).` : 'Password changed.',
      });
    } catch (err) {
      setStatus({ kind: 'error', text: msg(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Password</h2>
      <p className="muted small">Changing it signs you out everywhere else.</p>
      <form onSubmit={submit} className="stack">
        <label>
          Current password
          <input type="password" value={form.current} onChange={set('current')} autoComplete="current-password" required />
        </label>
        <label>
          New password <span className="muted small">(10+ characters)</span>
          <input type="password" value={form.next} onChange={set('next')} autoComplete="new-password" minLength={10} required />
        </label>
        <label>
          Confirm new password
          <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        </label>
        {status && <p className={status.kind === 'ok' ? 'ok' : 'error'}>{status.text}</p>}
        <button className="primary" disabled={busy}>
          Change password
        </button>
      </form>
    </section>
  );
}
