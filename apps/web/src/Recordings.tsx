import { useEffect, useState } from 'react';
import { api, ApiError, type Recording, type RecordingStorage, type TankListItem } from './api.ts';
import { useRealtimeEvent } from './realtime.ts';
import { Link, navigate } from './router.tsx';
import { bytes, clock, deletesIn, useNow } from './recording.tsx';

/** /recordings and /recordings/<id>: every recording until it's wiped, with a player. */
export function RecordingsPage({ openId, isAdmin }: { openId: string | null; isAdmin: boolean }) {
  const [list, setList] = useState<Recording[] | null>(null);
  const [storage, setStorage] = useState<RecordingStorage | null>(null);
  const [error, setError] = useState('');
  const now = useNow(true, 30_000);

  const load = () =>
    api.recordings().then(
      (r) => {
        setList(r.recordings);
        setStorage(r.storage);
        setError('');
      },
      (e) => setError(e instanceof ApiError ? e.message : 'Could not load recordings'),
    );
  useEffect(() => {
    load();
  }, []);
  useRealtimeEvent((e) => {
    if (e.type === 'recordings.changed' || e.type === 'connected') load();
  });

  const open = list?.find((r) => r.id === openId) ?? null;
  const wipe = async (r: Recording) => {
    if (!confirm(`Delete “${r.tankName}” (${new Date(r.startedAt).toLocaleString()}) for everyone now? This can't be undone.`)) return;
    try {
      await api.deleteRecording(r.id);
      if (openId === r.id) navigate('/recordings', true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete');
    }
    load();
  };

  return (
    <main className="page wide">
      <Link to="/" className="small">
        ← Home
      </Link>
      {open && open.status === 'ready' && <Player rec={open} now={now} isAdmin={isAdmin} onDelete={() => wipe(open)} />}
      {openId && list && !open && (
        <section className="card">
          <p className="muted">That recording is gone. It may have been deleted or expired.</p>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Recordings</h2>
          {storage && (
            <span className="muted small">
              {bytes(storage.usedBytes)} used · {bytes(storage.freeBytes)} free · kept {storage.keepDays} days
            </span>
          )}
        </div>
        <p className="muted small">
          Recordings of Tanks, for everyone with an account. Each is deleted automatically a few days after it ends. Anyone
          watching can save their own copy, so deleting only removes the server's copy.
        </p>
        {error && <p className="error">{error}</p>}
        {list === null ? (
          <p className="muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="muted">No recordings yet. Admins can record a Tank from its side panel.</p>
        ) : (
          <ul className="rec-list">
            {list.map((r) => (
              <li key={r.id} className={r.id === openId ? 'current' : undefined}>
                <div className="rec-main">
                  {r.status === 'ready' ? (
                    <Link to={`/recordings/${r.id}`} className="plain rec-title">
                      ▶ <strong>{r.tankName}</strong>
                      {r.kind === 'clip' && <span className="clip-tag">CLIP</span>}
                    </Link>
                  ) : (
                    <strong className="rec-title">{r.tankName}</strong>
                  )}
                  <span className="muted small">
                    {new Date(r.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {r.kind === 'clip' ? 'clipped by' : 'by'} {r.startedBy}
                  </span>
                </div>
                <div className="rec-meta small">
                  {r.status === 'recording' ? (
                    <span className="rec-live">
                      <span className="rec-dot" aria-hidden /> Recording now · {clock(now - r.startedAt)}
                    </span>
                  ) : r.status === 'processing' ? (
                    <span className="muted">Finishing up…</span>
                  ) : (
                    <>
                      <span>{clock(r.durationMs ?? 0)}</span>
                      {r.parts.length > 1 && <span className="muted"> · {r.parts.length} parts</span>}
                      <span className="muted"> · {bytes(r.sizeBytes)}</span>
                    </>
                  )}
                  {r.expiresAt && <span className="muted block">{deletesIn(r.expiresAt, now)}</span>}
                </div>
                {isAdmin && r.status === 'ready' && (
                  <button className="link danger small" onClick={() => wipe(r)}>
                    Delete now
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** "Watch together": send this recording to an open Tank you're in, to play on its screen. */
function ShareToTank({ rec }: { rec: Recording }) {
  const [tanks, setTanks] = useState<TankListItem[] | null>(null);
  const [tankId, setTankId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tankId?: string } | null>(null);
  const load = () =>
    api.tanks().then(
      (r) => {
        const open = r.tanks.filter((t) => t.status === 'open');
        setTanks(open);
        setTankId((cur) => (open.some((t) => t.id === cur) ? cur : (open[0]?.id ?? '')));
      },
      () => setTanks([]),
    );
  useEffect(() => {
    load();
  }, []);
  useRealtimeEvent((e) => {
    if (e.type === 'tank.updated' || e.type === 'tank.closed') load();
  });
  if (!tanks || tanks.length === 0) return null;

  const share = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.shareRecording(tankId, rec.id);
      setMsg({ ok: true, text: "Sent. It opens by itself if the Tank's Recordings page is open.", tankId });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not share it' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row timer-row">
      <span className="muted small">Watch together in</span>
      <select value={tankId} onChange={(e) => setTankId(e.target.value)} aria-label="Tank">
        {tanks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <button className="primary" disabled={busy || !tankId} onClick={share} title="Everyone in that Tank, guests included, will see it">
        ▶ Open in Tank
      </button>
      {msg && (
        <span className={msg.ok ? 'muted small' : 'error'}>
          {msg.text}{' '}
          {msg.tankId && (
            <Link to={`/t/${msg.tankId}`} className="small">
              Go to the Tank →
            </Link>
          )}
        </span>
      )}
    </div>
  );
}

function Player({ rec, now, isAdmin, onDelete }: { rec: Recording; now: number; isAdmin: boolean; onDelete: () => void }) {
  const [part, setPart] = useState(0);
  useEffect(() => setPart(0), [rec.id]);
  const src = `/api/recordings/${rec.id}/video?part=${part}`;
  return (
    <section className="card player">
      <div className="card-head">
        <h2>
          {rec.tankName} {rec.kind === 'clip' && <span className="clip-tag">CLIP</span>}
        </h2>
        <span className="muted small">{deletesIn(rec.expiresAt, now)}</span>
      </div>
      {/* key: a new part loads a fresh element (and starts from its beginning). */}
      <video key={src} src={src} controls preload="metadata" playsInline className="rec-video" />
      {rec.parts.length > 1 && (
        <div className="row parts" role="tablist" aria-label="Parts">
          {rec.parts.map((p) => (
            <button key={p.index} role="tab" aria-selected={p.index === part} className="small-btn" onClick={() => setPart(p.index)}>
              Part {p.index + 1} · {clock(p.durationMs)}
            </button>
          ))}
          <span className="muted small">The stream dropped and resumed, so it's in parts.</span>
        </div>
      )}
      <ShareToTank rec={rec} />
      <p className="muted small">
        {rec.kind === 'clip' ? 'Clipped' : 'Recorded'} by {rec.startedBy} on {new Date(rec.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
        {clock(rec.durationMs ?? 0)} · {bytes(rec.sizeBytes)}
        {isAdmin && (
          <>
            {' · '}
            <button className="link danger small" onClick={onDelete}>
              Delete now
            </button>
          </>
        )}
      </p>
    </section>
  );
}
