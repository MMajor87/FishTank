import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AdminOverview, type Recording, type RecordingStorage, type RegistrationCode } from './api.ts';
import { bytes, clock } from './recording.tsx';
import { useRealtimeEvent } from './realtime.ts';
import { Link } from './router.tsx';
import { Avatar } from './Avatar.tsx';

const ago = (ms: number | null) => {
  if (!ms) return '—';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const left = (ms: number) => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

export function AdminPage({ me }: { me: string }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  /** null = recording is off on this server. */
  const [recs, setRecs] = useState<{ recordings: Recording[]; storage: RecordingStorage | null } | null>(null);

  const loadRecordings = () => api.recordings().then(setRecs, () => setRecs(null));
  useEffect(() => {
    loadRecordings();
  }, []);

  const load = () =>
    api.adminOverview().then(
      (d) => {
        setData(d);
        setError('');
      },
      (e) => setError(e instanceof ApiError ? e.message : 'Could not load'),
    );

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000); // CPU/memory refresh
    return () => clearInterval(t);
  }, []);
  useRealtimeEvent((e) => {
    if (e.type === 'presence' || e.type === 'connected' || e.type === 'tank.updated' || e.type === 'tank.closed') load();
    if (e.type === 'recordings.changed' || e.type === 'tank.recording' || e.type === 'connected') loadRecordings();
  });

  const act = async (fn: () => Promise<unknown>, question?: string) => {
    if (question && !confirm(question)) return;
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed');
    }
    load();
  };

  if (!data) return <main className="page">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;

  const cpuTotal = data.tanks.reduce((n, t) => n + (t.stats?.cpuPercent ?? 0), 0);
  const memTotal = data.tanks.reduce((n, t) => n + (t.stats?.memoryMb ?? 0), 0);

  return (
    <main className="page wide">
      <Link to="/" className="small">
        ← Home
      </Link>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <div className="card-head">
          <h2>Live Tanks</h2>
          <span className="muted small">
            {data.tanks.length} of {data.limits.maxTanks} · {(cpuTotal / 100).toFixed(1)} cores · {(memTotal / 1024).toFixed(1)} GB
          </span>
        </div>
        {data.tanks.length === 0 ? (
          <p className="muted">No Tanks running.</p>
        ) : (
          <div className="table-scroll">
            <table className="codes">
              <thead>
                <tr>
                  <th>Tank</th>
                  <th>Host</th>
                  <th>People</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Idle since</th>
                  <th>Time left</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.tanks.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>
                      {t.status === 'starting' && <span className="muted small"> · starting</span>}
                      {t.recordingId && <span className="rec-tag">REC</span>}
                      <div className="muted small mono">UDP {t.udpPort}</div>
                    </td>
                    <td>{t.hostDisplayName}</td>
                    <td>
                      {t.viewerCount} watching / {t.memberCount}
                    </td>
                    <td>
                      <Meter value={t.stats?.cpuPercent ?? null} max={data.limits.cpusPerTank * 100} label={t.stats ? `${(t.stats.cpuPercent / 100).toFixed(1)} cores` : '—'} />
                    </td>
                    <td>
                      <Meter value={t.stats?.memoryMb ?? null} max={data.limits.memoryGbPerTank * 1024} label={t.stats ? `${t.stats.memoryMb} MB` : '—'} />
                    </td>
                    <td>{t.viewerCount > 0 ? <span className="ok">watching</span> : ago(t.lastActiveAt)}</td>
                    <td>{left(t.expiresAt)}</td>
                    <td className="right">
                      <button
                        className="link danger"
                        onClick={() => act(() => api.drainTank(t.id), `Close “${t.name}” for everyone? Its browser and logins are destroyed.`)}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {recs?.storage && (
        <section className="card">
          <div className="card-head">
            <h2>Recordings</h2>
            <Link to="/recordings" className="small">
              Open recordings →
            </Link>
          </div>
          <p className="small">
            {recs.recordings.filter((r) => r.status === 'ready').length} saved · {bytes(recs.storage.usedBytes)} used ·{' '}
            {bytes(recs.storage.freeBytes)} free on the recordings disk · kept {recs.storage.keepDays} days after they end
          </p>
          {recs.storage.freeBytes !== null && recs.storage.freeBytes < recs.storage.minFreeGb * 1024 ** 3 && (
            <p className="error">Less than {recs.storage.minFreeGb} GB free: new recordings can't start until space is freed.</p>
          )}
          {recs.recordings
            .filter((r) => r.status === 'recording')
            .map((r) => (
              <p key={r.id} className="small">
                <span className="rec-tag">REC</span> <strong>{r.tankName}</strong> · by {r.startedBy} ·{' '}
                {clock(Date.now() - r.startedAt)} so far. Stop it from the Tank's page or close the Tank above.
              </p>
            ))}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Guests</h2>
          <span className="muted small">No account · watch only · removed when they leave</span>
        </div>
        {data.guests.length === 0 ? (
          <p className="muted">No guests right now.</p>
        ) : (
          <div className="table-scroll">
            <table className="codes">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Tank</th>
                  <th>Invited by</th>
                  <th>Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.guests.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <span className={`dot inline ${g.online ? 'on' : ''}`} aria-label={g.online ? 'Online' : 'Offline'} /> {g.displayName}
                    </td>
                    <td>{g.guestTankName ?? '—'}</td>
                    <td>{g.invitedBy ? `@${g.invitedBy}` : <span className="muted">—</span>}</td>
                    <td>{ago(g.createdAt)}</td>
                    <td className="right">
                      <button className="link danger" onClick={() => act(() => api.disableUser(g.id), `End ${g.displayName}'s guest pass? They're removed from the Tank.`)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Accounts</h2>
          <span className="muted small">
            {data.users.filter((u) => u.online).length} online · {data.users.length} total
          </span>
        </div>
        <div className="table-scroll">
          <table className="codes">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Invited by</th>
                <th>2FA</th>
                <th>Last seen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className={`dot inline ${u.online ? 'on' : ''}`} aria-label={u.online ? 'Online' : 'Offline'} />{' '}
                    <Avatar name={u.displayName} url={u.avatarUrl} seed={u.id} size={24} /> {u.displayName}{' '}
                    <span className="muted small mono">@{u.username}</span>
                  </td>
                  <td>{u.role}</td>
                  <td>{u.invitedBy ? `@${u.invitedBy}` : <span className="muted">—</span>}</td>
                  <td>{u.totp ? <span className="ok">on</span> : <span className="muted">off</span>}</td>
                  <td>{u.online ? 'now' : ago(u.lastSeenAt)}</td>
                  <td>{u.disabled ? <span className="error">disabled</span> : 'active'}</td>
                  <td className="right">
                    {u.id === me ? (
                      <span className="muted small">you</span>
                    ) : u.disabled ? (
                      <button className="link" onClick={() => act(() => api.enableUser(u.id))}>
                        Enable
                      </button>
                    ) : (
                      <button
                        className="link danger"
                        onClick={() =>
                          act(
                            () => api.disableUser(u.id),
                            `Disable @${u.username}? They're signed out everywhere, Tanks they host are drained, and they're removed from other Tanks.`,
                          )
                        }
                      >
                        Disable
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <SignupCodes all />

      <section className="card">
        <div className="card-head">
          <h2>Invite log</h2>
          <span className="muted small">Every new account and guest, and who invited them (latest 100)</span>
        </div>
        {data.invites.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="codes">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Type</th>
                  <th>Invited by</th>
                  <th>Tank</th>
                  <th>Ended</th>
                </tr>
              </thead>
              <tbody>
                {data.invites.map((i) => (
                  <tr key={i.id}>
                    <td title={new Date(i.createdAt).toLocaleString()}>{ago(i.createdAt)}</td>
                    <td>{i.userName}</td>
                    <td>{i.kind === 'guest' ? <span className="badge">guest</span> : 'account'}</td>
                    <td>{i.invitedByName ? `@${i.invitedByName}` : <span className="muted">{i.kind === 'account' ? 'first admin' : '—'}</span>}</td>
                    <td>{i.tankName ?? <span className="muted">—</span>}</td>
                    <td>{i.endedAt ? `${ago(i.endedAt)} · ${i.endReason ?? ''}` : i.kind === 'guest' ? <span className="ok">active</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * Sign-up codes: the only way to make a permanent account. On the home page everyone sees and
 * makes their own; on the Admin page (`all`) admins see everyone's, with who made each one.
 */
export function SignupCodes({ all = false }: { all?: boolean }) {
  const [codes, setCodes] = useState<RegistrationCode[]>([]);
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<{ code: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.listCodes(all).then((r) => setCodes(r.codes), () => {});
  useEffect(() => {
    load();
  }, []);

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

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const c = await api.createCode(note.trim() || undefined);
      setFresh(c);
      setCopied(false);
      setNote('');
      await load();
    });
  };

  const inviteLink = fresh ? `${location.origin}/?code=${encodeURIComponent(fresh.code)}` : '';

  return (
    <section className="card">
      <div className="card-head">
        <h2>{all ? 'Sign-up codes' : 'Invite someone to FishTank'}</h2>
        {all && <span className="muted small">Everyone's codes · one use · 3 days</span>}
      </div>
      <p className="muted small">
        A sign-up code gives someone a permanent FishTank account. Each works once and expires after 3 days. (Tank invite
        links don't make accounts: people without one watch that Tank as a guest.)
      </p>
      <form onSubmit={create} className="row">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who is it for? (optional)" maxLength={80} />
        <button className="primary" disabled={busy}>
          New code
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      {fresh && (
        <div className="fresh">
          <div className="mono big">{fresh.code}</div>
          <p className="small muted">Copy it now. For security it won't be shown again.</p>
          <div className="row">
            <input readOnly value={inviteLink} onFocus={(e) => e.target.select()} className="mono small" />
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(inviteLink);
                setCopied(true);
              }}
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
        </div>
      )}

      {codes.length > 0 && (
        <div className="table-scroll">
          <table className="codes">
            <thead>
              <tr>
                <th>For</th>
                {all && <th>Made by</th>}
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const status = codeStatus(c);
                return (
                  <tr key={c.id}>
                    <td>{c.note ?? <span className="muted">—</span>}</td>
                    {all && <td>{c.createdBy ? `@${c.createdBy}` : <span className="muted">system</span>}</td>}
                    <td>
                      <span className={`status ${status.kind}`}>{status.label}</span>
                    </td>
                    <td className="right">
                      {status.kind === 'active' && (
                        <button className="link" onClick={() => run(async () => { await api.revokeCode(c.id); await load(); })}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function codeStatus(c: RegistrationCode): { kind: string; label: string } {
  if (c.usedAt) return { kind: 'used', label: `Joined as ${c.usedBy ?? 'deleted user'}` };
  if (c.revokedAt) return { kind: 'dead', label: 'Revoked' };
  if (c.expiresAt <= Date.now()) return { kind: 'dead', label: 'Expired' };
  const hours = Math.max(1, Math.round((c.expiresAt - Date.now()) / 3_600_000));
  return { kind: 'active', label: hours >= 24 ? `Active · ${Math.round(hours / 24)}d left` : `Active · ${hours}h left` };
}

function Meter({ value, max, label }: { value: number | null; max: number; label: string }) {
  const pct = value === null ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="meter" title={label}>
      <div className={`meter-bar${pct > 85 ? ' hot' : ''}`} style={{ width: `${pct}%` }} />
      <span className="small">{label}</span>
    </div>
  );
}
