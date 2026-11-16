import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type FriendTank, type TankInvite, type TankListItem } from './api.ts';
import { Avatar } from './Avatar.tsx';
import { useRealtimeEvent } from './realtime.ts';
import { Link, navigate } from './router.tsx';

/** Scaled-down screenshot of a Tank, refreshed by the server every few minutes. */
function Preview({ tankId, at }: { tankId: string; at: number | null }) {
  return (
    <span className="tile-preview">
      {at ? <img src={`/api/tanks/${tankId}/preview?v=${at}`} alt="" loading="lazy" /> : <span className="muted small">No preview yet</span>}
    </span>
  );
}

/** Home-page card: your live Tanks, invites waiting for you, and "New Tank". */
export function TanksCard() {
  const [tanks, setTanks] = useState<TankListItem[]>([]);
  const [invites, setInvites] = useState<TankInvite[]>([]);
  const [friendTanks, setFriendTanks] = useState<FriendTank[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.tanks().then((r) => setTanks(r.tanks), () => {});
    api.tankInvites().then((r) => setInvites(r.invites), () => {});
    api.friendsTanks().then((r) => setFriendTanks(r.tanks), () => {});
  };
  useEffect(load, []);
  useRealtimeEvent((e) => {
    if (e.type === 'tank.updated' || e.type === 'tank.closed' || e.type === 'tank.removed' || e.type === 'tank.invite' || e.type === 'connected') load();
    else if (e.type === 'friends.tanks' || e.type === 'friends.changed') api.friendsTanks().then((r) => setFriendTanks(r.tanks), () => {});
  });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
      load();
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const { tank } = await api.createTank(name.trim() || 'Watch party');
      navigate(`/t/${tank.id}`);
    });
  };

  const hosting = tanks.some((t) => t.role === 'host');

  return (
    <section className="card">
      <h2>Your Tanks</h2>

      {invites.length > 0 && (
        <div className="group invites">
          <h3>Invites</h3>
          <ul className="people">
            {invites.map((i) => (
              <li key={i.id}>
                <span className="person">
                  <strong>{i.tankName}</strong> <span className="muted small">from {i.byDisplayName ?? 'someone'}</span>
                </span>
                <div className="actions">
                  <button
                    className="primary small-btn"
                    disabled={busy}
                    onClick={() => run(async () => navigate(`/t/${(await api.acceptTankInvite(i.id)).tankId}`))}
                  >
                    Join
                  </button>
                  <button className="small-btn" disabled={busy} onClick={() => run(async () => { await api.declineTankInvite(i.id); load(); })}>
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tanks.length > 0 ? (
        <ul className="tank-tiles group">
          {tanks.map((t) => (
            <li key={t.id}>
              <Link to={`/t/${t.id}`} className={`tank-tile plain${t.role === 'host' ? ' mine' : ''}`}>
                <Preview tankId={t.id} at={t.previewAt} />
                <span className="tile-top">
                  <span className={`dot ${t.status === 'open' ? 'on' : 'starting'}`} />
                  <span className="muted small">{t.status === 'starting' ? 'Starting…' : 'Live'}</span>
                  {t.role === 'host' && <span className="badge">host</span>}
                </span>
                <strong className="tile-name">{t.name}</strong>
                <span className="muted small tile-host">
                  {t.role === 'host' ? 'You host' : `Hosted by ${t.hostDisplayName}`}
                </span>
                <span className="tile-foot">
                  <span className="small">
                    {t.status === 'open' && <>{t.viewerCount} watching · </>}
                    <span className="muted">{t.memberCount} {t.memberCount === 1 ? 'member' : 'members'}</span>
                  </span>
                  <span className="tile-open">Open →</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No Tanks open. Start one and invite your friends. It disappears when you drain it.</p>
      )}

      {friendTanks.length > 0 && (
        <div className="group">
          <h3>Friends' Tanks</h3>
          <ul className="tank-tiles">
            {friendTanks.map((t) => (
              <li key={t.id}>
                <button
                  className="tank-tile plain friend-tile"
                  disabled={busy || t.status !== 'open'}
                  onClick={() => run(async () => navigate(`/t/${(await api.joinFriendTank(t.id)).tankId}`))}
                >
                  <Preview tankId={t.id} at={t.previewAt} />
                  <span className="tile-top">
                    <span className={`dot ${t.status === 'open' ? 'on' : 'starting'}`} />
                    <span className="muted small">{t.status === 'starting' ? 'Starting…' : 'Live'}</span>
                  </span>
                  <strong className="tile-name">{t.name}</strong>
                  <span className="muted small tile-host">
                    <Avatar name={t.hostDisplayName} url={t.hostAvatarUrl} seed={t.hostId} size={18} /> {t.hostDisplayName}
                  </span>
                  <span className="tile-foot">
                    <span className="small">
                      {t.status === 'open' && <>{t.viewerCount} watching · </>}
                      <span className="muted">{t.memberCount} {t.memberCount === 1 ? 'member' : 'members'}</span>
                    </span>
                    <span className="tile-open">{t.status === 'open' ? 'Join →' : 'Wait…'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hosting && (
        <form onSubmit={create} className="row group">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your Tank (e.g. Movie night)" maxLength={40} />
          <button className="primary" disabled={busy}>
            {busy ? 'Starting…' : 'New Tank'}
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
