import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type Features, type User } from './api.ts';
import { Friends } from './Friends.tsx';
import { TanksCard } from './Tanks.tsx';
import { TankPage } from './TankPage.tsx';
import { AccountPage } from './Account.tsx';
import { AdminPage, SignupCodes } from './Admin.tsx';
import { RecordingsPage } from './Recordings.tsx';
import { Avatar } from './Avatar.tsx';
import { useRealtimeConnection, useRealtimeEvent } from './realtime.ts';
import { Link, matchRoute, navigate, usePath } from './router.tsx';

const GUEST_ENDED: Record<string, string> = {
  left: 'You left the Tank.',
  disconnected: 'You were away for a couple of minutes.',
  'removed by host': 'The host removed you.',
  'Tank drained': 'The Tank was drained.',
  'disabled by an admin': 'An admin ended your guest pass.',
};

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  /** Why a guest pass ended (shown instead of the login screen). */
  const [guestEnded, setGuestEnded] = useState<string | null>(null);
  const [features, setFeatures] = useState<Features>({ recordings: false });
  const route = matchRoute(usePath());

  useEffect(() => {
    api.me().then((r) => setUser(r.user), () => setUser(null));
  }, []);
  // Optional features (e.g. recordings) depend on the server and on who you are.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return setFeatures({ recordings: false });
    api.me().then((r) => setFeatures(r.features ?? { recordings: false }), () => {});
  }, [userId]);

  const signedOut = (reason = '') => {
    if (user?.guestTankId) setGuestEnded(GUEST_ENDED[reason.replace(/^guest:/, '')] ?? 'Your guest pass has ended.');
    setUser(null);
  };

  if (user === undefined) return <div className="center muted">Filling the tank…</div>;

  if (!user) {
    if (guestEnded) return <GuestEnded reason={guestEnded} />;
    if (route.name === 'join') return <JoinAsGuestScreen code={route.code} onAuthed={setUser} />;
    const code = new URLSearchParams(location.search).get('code') ?? '';
    return (
      <AuthScreen
        initialCode={code}
        onAuthed={(u) => {
          history.replaceState(null, '', location.pathname);
          setUser(u);
        }}
      />
    );
  }

  // Guests only ever see the one Tank they were invited to.
  if (user.guestTankId) {
    if (route.name !== 'tank' || route.id !== user.guestTankId) queueMicrotask(() => navigate(`/t/${user.guestTankId}`, true));
    return (
      <Shell user={user} onLogout={signedOut}>
        <TankPage key={user.guestTankId} id={user.guestTankId} me={user.id} asGuest />
      </Shell>
    );
  }

  let page: ReactNode;
  switch (route.name) {
    case 'home':
      page = (
        <main className="page home">
          <aside className="home-side" aria-label="Friends">
            <Friends myUsername={user.username} />
            <SignupCodes />
          </aside>
          <div className="home-main">
            <TanksCard />
          </div>
        </main>
      );
      break;
    case 'tank':
      page = <TankPage key={route.id} id={route.id} me={user.id} />;
      break;
    case 'account':
      page = <AccountPage user={user} onUserChange={setUser} />;
      break;
    case 'recordings':
      page = features.recordings ? (
        <RecordingsPage openId={route.id} isAdmin={user.role === 'admin'} />
      ) : (
        <main className="page">
          <p className="muted">Recording isn't turned on on this server.</p>
        </main>
      );
      break;
    case 'admin':
      page = user.role === 'admin' ? <AdminPage me={user.id} /> : <main className="page"><p className="muted">Admins only.</p></main>;
      break;
    case 'join':
      page = <JoinPage code={route.code} />;
      break;
    default:
      page = (
        <main className="page">
          <section className="card">
            <h2>Nothing swimming here</h2>
            <Link to="/">← Back home</Link>
          </section>
        </main>
      );
  }

  return (
    <Shell user={user} onLogout={signedOut} features={features}>
      {page}
    </Shell>
  );
}

/* ---------- Logged-in shell: header, realtime socket, toasts ---------- */

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

function Shell({
  user,
  onLogout,
  features = { recordings: false },
  children,
}: {
  user: User;
  onLogout: (reason?: string) => void;
  features?: Features;
  children: ReactNode;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = (text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 15000 : 6000);
  };
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  // Session ended elsewhere (logged out, expired, or disabled) → back to login.
  const connection = useRealtimeConnection(onLogout);

  useRealtimeEvent((e) => {
    if (e.type === 'friends.changed' && e.by) {
      if (e.reason === 'request') toast(`${e.by.displayName} (@${e.by.username}) sent you a friend request`);
      if (e.reason === 'accepted') toast(`${e.by.displayName} accepted your friend request`);
    }
    if (e.type === 'tank.recording' && e.active && e.by) toast(`🔴 ${e.by} started recording “${e.name}”`);
    if (e.type === 'tank.recording' && !e.active) toast(`“${e.name}” is no longer being recorded`);
    if (e.type === 'tank.clip') toast(`✂ ${e.by} saved a clip of the last ${e.seconds} seconds. It's under Recordings.`);
    if (e.type === 'tank.playback') toast(`📼 ${e.by} opened the recording “${e.title}” in the Tank`);
    if (e.type === 'tank.invite') {
      const { invite } = e;
      toast(`${invite.by?.displayName ?? 'Someone'} invited you to “${invite.tank.name}”`, {
        label: 'Join',
        run: () => api.acceptTankInvite(invite.id).then((r) => navigate(`/t/${r.tankId}`), () => navigate('/')),
      });
    }
  });

  const logout = async () => {
    if (user.guestTankId) {
      if (!confirm('Leave? Your guest pass ends and you would need a new link to come back.')) return;
      await api.leaveTank(user.guestTankId).catch(() => {});
      return onLogout('guest:left');
    }
    await api.logout().catch(() => {});
    onLogout();
  };

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand plain">
          <span aria-hidden>🐟</span> FishTank
        </Link>
        <span className="spacer" />
        {connection === 'reconnecting' && <span className="muted small">Reconnecting…</span>}
        {user.guestTankId ? (
          <span className="plain muted me-link">
            <Avatar name={user.displayName} url={null} seed={user.id} size={30} />
            {user.displayName}
            <span className="badge">guest</span>
          </span>
        ) : (
          <>
            {features.recordings && (
              <Link to="/recordings" className="plain muted small">
                Recordings
              </Link>
            )}
            {user.role === 'admin' && (
              <Link to="/admin" className="plain muted small">
                Admin
              </Link>
            )}
            <Link to="/account" className="plain muted me-link">
              <Avatar name={user.displayName} url={user.avatarUrl} seed={user.id} size={30} />
              {user.displayName}
              {user.role === 'admin' && <span className="badge">admin</span>}
            </Link>
          </>
        )}
        <button onClick={logout}>{user.guestTankId ? 'Leave' : 'Log out'}</button>
      </header>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                className="primary small-btn"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- /join/<code> while logged in ---------- */

function JoinPage({ code }: { code: string }) {
  const [error, setError] = useState('');
  useEffect(() => {
    api.redeemTankCode(code).then(
      (r) => navigate(`/t/${r.tankId}`, true),
      (e) => setError(e instanceof ApiError ? e.message : 'Could not join'),
    );
  }, [code]);
  return (
    <main className="page">
      <section className="card">
        {error ? (
          <>
            <h2>Can't join</h2>
            <p className="error">{error}</p>
            <Link to="/">← Back home</Link>
          </>
        ) : (
          <p className="muted">Joining the Tank…</p>
        )}
      </section>
    </main>
  );
}

/* ---------- Logged out ---------- */

/** /join/<TANK code> while logged out: watch as a temporary guest, or log in to join as yourself. */
function JoinAsGuestScreen({ code, onAuthed }: { code: string; onAuthed: (u: User) => void }) {
  const [info, setInfo] = useState<{ tankName: string; host: string; recording?: boolean } | null | undefined>(undefined);
  const [login, setLogin] = useState(false);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    api.tankCodeInfo(code).then(setInfo, () => setInfo(null));
  }, [code]);

  const watch = () =>
    run(async () => {
      const { tankId } = await api.joinAsGuest(code);
      navigate(`/t/${tankId}`, true);
      onAuthed((await api.me()).user);
    });

  return (
    <main className="center">
      <div className="card auth">
        <h1 className="brand">
          <span aria-hidden>🐟</span> FishTank
        </h1>
        {info === undefined ? (
          <p className="muted">Checking your invite…</p>
        ) : info === null ? (
          <>
            <p className="error">This invite link is invalid, used up, or expired. Ask the host for a new one.</p>
            <button className="link" onClick={() => navigate('/', true)}>
              Log in instead
            </button>
          </>
        ) : login ? (
          <>
            <p className="muted">
              Log in to join <strong>{info.tankName}</strong> with your account.
            </p>
            {/* After login the app shows /join/<code>, which joins with the account. */}
            <LoginForm onAuthed={onAuthed} />
            <button className="link" onClick={() => setLogin(false)}>
              ← Watch as a guest instead
            </button>
          </>
        ) : (
          <>
            <p>
              <strong>{info.host}</strong> invited you to watch <strong>“{info.tankName}”</strong>.
            </p>
            {info.recording && (
              <p className="rec-warning">
                <span className="rec-dot" aria-hidden /> This Tank is being recorded. What's on its screen, including your name
                in its member list, may be saved and watched later by people with a FishTank account.
              </p>
            )}
            <p className="muted small">
              No account needed. You'll get a random name and can watch, but not control the browser. Your guest pass
              ends when you close this page or the Tank is drained.
            </p>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy} onClick={watch}>
              {busy ? 'Diving in…' : 'Watch as a guest'}
            </button>
            <button className="link" onClick={() => setLogin(true)}>
              I have a FishTank account
            </button>
          </>
        )}
      </div>
    </main>
  );
}

function GuestEnded({ reason }: { reason: string }) {
  return (
    <main className="center">
      <div className="card auth">
        <h1 className="brand">
          <span aria-hidden>🐟</span> FishTank
        </h1>
        <h2>Thanks for watching</h2>
        <p className="muted">{reason} Your guest pass has ended and nothing about it was kept. To watch again, ask the host for a new link.</p>
      </div>
    </main>
  );
}

function AuthScreen({ onAuthed, initialCode }: { onAuthed: (u: User) => void; initialCode: string }) {
  const [mode, setMode] = useState<'login' | 'register'>(initialCode ? 'register' : 'login');

  return (
    <main className="center">
      <div className="card auth">
        <h1 className="brand">
          <span aria-hidden>🐟</span> FishTank
        </h1>
        <p className="muted">Private watch parties for your school of friends.</p>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
            Log in
          </button>
          <button role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')}>
            I have a sign-up code
          </button>
        </div>
        {mode === 'login' ? <LoginForm onAuthed={onAuthed} /> : <RegisterForm onAuthed={onAuthed} initialCode={initialCode} />}
      </div>
    </main>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function LoginForm({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const { busy, error, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      try {
        onAuthed((await api.login(username, password, needCode ? code.trim() : undefined)).user);
      } catch (err) {
        if (err instanceof ApiError && err.data.totpRequired) {
          setNeedCode(true);
          setCode('');
        }
        throw err;
      }
    });
  };

  return (
    <form onSubmit={submit} className="stack">
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus={!needCode} readOnly={needCode} />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required readOnly={needCode} />
      </label>
      {needCode && (
        <label>
          Authenticator code <span className="muted small">(or a recovery code)</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" required autoFocus className="mono" />
        </label>
      )}
      {error && !(needCode && !code && error.startsWith('Enter the code')) && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>
        {busy ? 'Diving in…' : 'Log in'}
      </button>
    </form>
  );
}

function RegisterForm({ onAuthed, initialCode }: { onAuthed: (u: User) => void; initialCode: string }) {
  const [form, setForm] = useState({ code: initialCode, username: '', displayName: '', password: '', confirm: '' });
  const { busy, error, run } = useSubmit();
  const [localError, setLocalError] = useState('');
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setLocalError('Passwords do not match');
    setLocalError('');
    run(async () => {
      const r = await api.register({ code: form.code, username: form.username, displayName: form.displayName, password: form.password });
      onAuthed(r.user);
    });
  };

  return (
    <form onSubmit={submit} className="stack">
      <label>
        Sign-up code
        <input value={form.code} onChange={set('code')} placeholder="FISH-…" required spellCheck={false} className="mono" />
      </label>
      <label>
        Username
        <input value={form.username} onChange={set('username')} autoComplete="username" required pattern="[A-Za-z0-9_.\-]{3,24}" title="3–24 letters, numbers, _ . -" />
      </label>
      <label>
        Display name
        <input value={form.displayName} onChange={set('displayName')} required maxLength={40} />
      </label>
      <label>
        Password <span className="muted small">(10+ characters)</span>
        <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required minLength={10} />
      </label>
      <label>
        Confirm password
        <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
      </label>
      {(localError || error) && <p className="error">{localError || error}</p>}
      <button className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}
