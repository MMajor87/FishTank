import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Relations } from './api.ts';
import { useRealtimeEvent } from './realtime.ts';
import { navigate } from './router.tsx';
import { Avatar } from './Avatar.tsx';

const EMPTY: Relations = { friends: [], incoming: [], outgoing: [], blocked: [] };

/** Friends panel: refetches when the realtime socket says relationships changed; live presence. */
export function Friends({ myUsername }: { myUsername: string }) {
  const [rel, setRel] = useState<Relations>(EMPTY);
  const [presence, setPresence] = useState<Map<string, boolean>>(new Map());
  const [username, setUsername] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.relations().then(setRel, () => {});
  useEffect(() => {
    load();
  }, []);
  useRealtimeEvent((e) => {
    if (e.type === 'presence') setPresence((p) => new Map(p).set(e.userId, e.online));
    if (e.type === 'friends.changed' || e.type === 'friends.activity' || e.type === 'connected') load();
  });

  const act = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (okText) setMessage({ kind: 'ok', text: okText });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong' });
    } finally {
      setBusy(false);
      load();
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    act(async () => {
      const r = await api.sendFriendRequest(name);
      setUsername('');
      setMessage({ kind: 'ok', text: r.status === 'accepted' ? `You and ${name} are now friends` : `Request sent to ${name}` });
    });
  };

  const isOnline = (id: string, fallback: boolean) => presence.get(id) ?? fallback;
  const friends = [...rel.friends].sort((a, b) => Number(isOnline(b.id, b.online)) - Number(isOnline(a.id, a.online)));
  const onlineCount = friends.filter((f) => isOnline(f.id, f.online)).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Friends</h2>
        <span className="muted small">
          {friends.length > 0 ? `${onlineCount} of ${friends.length} online` : ''}
        </span>
      </div>
      <p className="muted small">
        Your username is <strong className="mono">{myUsername}</strong>. Share it so friends can add you.
      </p>

      <form onSubmit={add} className="row">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Add a friend by username" maxLength={64} spellCheck={false} />
        <button className="primary" disabled={busy || !username.trim()}>
          Add
        </button>
      </form>
      {message && <p className={message.kind === 'error' ? 'error' : 'ok'}>{message.text}</p>}

      {rel.incoming.length > 0 && (
        <div className="group">
          <h3>Requests</h3>
          <ul className="people">
            {rel.incoming.map((u) => (
              <li key={u.id}>
                <Person name={u.displayName} username={u.username} url={u.avatarUrl} id={u.id} />
                <div className="actions">
                  <button className="primary small-btn" disabled={busy} onClick={() => act(() => api.acceptFriend(u.id), `You and ${u.displayName} are now friends`)}>
                    Accept
                  </button>
                  <button className="small-btn" disabled={busy} onClick={() => act(() => api.dropRequest(u.id))}>
                    Decline
                  </button>
                  <button
                    className="link danger"
                    disabled={busy}
                    onClick={() => confirm(`Block ${u.displayName}? They won't be able to find or friend you.`) && act(() => api.block(u.id))}
                  >
                    Block
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="group">
        {friends.length === 0 ? (
          <p className="muted">No friends yet. Add someone by username, or invite them to FishTank below.</p>
        ) : (
          <ul className="people">
            {friends.map((f) => {
              const online = isOnline(f.id, f.online);
              return (
                <li key={f.id}>
                  <span className={`dot ${online ? 'on' : ''}`} title={online ? 'Online' : 'Offline'} aria-label={online ? 'Online' : 'Offline'} />
                  <span className="friend-main">
                    <Person name={f.displayName} username={f.username} url={f.avatarUrl} id={f.id} />
                    {f.inTank && (
                      <span className="in-tank small">
                        <span aria-hidden="true">🐟</span>{' '}
                        {f.inTank.name ? <>Watching “{f.inTank.name}”</> : 'In a Tank'}
                        {f.inTank.id && (
                          <button
                            className="link"
                            disabled={busy}
                            onClick={() => act(async () => navigate(`/t/${(await api.joinFriendTank(f.inTank!.id!)).tankId}`))}
                          >
                            Join
                          </button>
                        )}
                      </span>
                    )}
                  </span>
                  <details className="menu">
                    <summary aria-label={`Options for ${f.displayName}`}>⋯</summary>
                    <div className="menu-items">
                      <button className="link" onClick={() => confirm(`Remove ${f.displayName} from your friends?`) && act(() => api.removeFriend(f.id))}>
                        Remove friend
                      </button>
                      <button
                        className="link danger"
                        onClick={() => confirm(`Block ${f.displayName}? This also removes them as a friend.`) && act(() => api.block(f.id))}
                      >
                        Block
                      </button>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {rel.outgoing.length > 0 && (
        <div className="group">
          <h3>Sent</h3>
          <ul className="people">
            {rel.outgoing.map((u) => (
              <li key={u.id}>
                <Person name={u.displayName} username={u.username} url={u.avatarUrl} id={u.id} />
                <span className="muted small">Pending</span>
                <button className="link" disabled={busy} onClick={() => act(() => api.dropRequest(u.id))}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rel.blocked.length > 0 && (
        <details className="group blocked">
          <summary className="muted small">Blocked ({rel.blocked.length})</summary>
          <ul className="people">
            {rel.blocked.map((u) => (
              <li key={u.id}>
                <Person name={u.displayName} username={u.username} url={u.avatarUrl} id={u.id} />
                <button className="link" disabled={busy} onClick={() => act(() => api.unblock(u.id))}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Person({ name, username, url, id }: { name: string; username: string; url?: string | null; id?: string }) {
  return (
    <>
    <Avatar name={name} url={url} seed={id} />
    <span className="person" title={`${name} (@${username})`}>
      <span>{name}</span> <span className="muted small mono">@{username}</span>
    </span>
    </>
  );
}
