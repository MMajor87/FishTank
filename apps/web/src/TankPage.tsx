import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Relations, type TankCode, type TankDetail, type TankMember } from './api.ts';
import { sendRealtime, useRealtimeEvent } from './realtime.ts';
import { Link, navigate } from './router.tsx';
import { Avatar } from './Avatar.tsx';

const REASONS: Record<string, string> = {
  'drained by host': 'The host drained this Tank.',
  idle: 'This Tank was drained because nobody was watching.',
  'time limit': 'This Tank reached its time limit.',
  'failed to start': "This Tank couldn't start. Try creating it again.",
  'closed by an admin': 'An admin closed this Tank.',
};

export function TankPage({ id, me, asGuest = false }: { id: string; me: string; asGuest?: boolean }) {
  const [detail, setDetail] = useState<TankDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('ft.tankPanel') === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('ft.tankPanel', c ? 'open' : 'collapsed');
      } catch {
        /* storage unavailable: just don't remember */
      }
      return !c;
    });
  // The iframe src is fixed once: refetching issues new tickets, and changing src would reload Neko.
  const [src, setSrc] = useState<string | null>(null);

  const load = () =>
    api.tank(id).then(
      (d) => {
        setDetail(d);
        if (d.embedUrl) setSrc((s) => s ?? d.embedUrl!);
      },
      (e) => e instanceof ApiError && e.status === 404 && setNotFound(true),
    );

  useEffect(() => {
    load();
  }, [id]);

  // Your friends and requests: drives the members' right-click menu and the invite list.
  const [rel, setRel] = useState<Relations | null>(null);
  const loadRelations = () => (asGuest ? Promise.resolve() : api.relations().then(setRel, () => {}));
  useEffect(() => {
    loadRelations();
  }, []);

  const status = detail?.tank.status;

  // Tell the server this tab is watching (drives idle detection and "watching" badges).
  useEffect(() => {
    if (status !== 'open') return;
    sendRealtime({ type: 'tank.join', tankId: id });
    return () => sendRealtime({ type: 'tank.leave' });
  }, [id, status]);

  useRealtimeEvent((e) => {
    if (e.type === 'connected' && status === 'open') sendRealtime({ type: 'tank.join', tankId: id });
    if ((e.type === 'tank.updated' || e.type === 'tank.closed') && e.tankId === id) load();
    if (e.type === 'tank.removed' && e.tankId === id) setRemoved(true);
    if (e.type === 'friends.changed') loadRelations();
  });

  if (removed)
    return (
      <main className="page">
        <section className="card">
          <h2>You were removed from this Tank</h2>
          <p className="muted">The host removed you. Ask them for a new invite if that was a mistake.</p>
          <Link to="/">← Back home</Link>
        </section>
      </main>
    );
  if (notFound)
    return (
      <main className="page">
        <section className="card">
          <h2>Tank not found</h2>
          <p className="muted">It may have been drained, or you haven't been invited.</p>
          <Link to="/">← Back home</Link>
        </section>
      </main>
    );
  if (!detail) return <div className="center muted">Finding the Tank…</div>;

  if (status === 'closed')
    return (
      <main className="page">
        <section className="card">
          <h2>{detail.tank.name}</h2>
          <p>{REASONS[detail.tank.closeReason ?? ''] ?? 'This Tank has been drained.'}</p>
          <p className="muted small">Everything that happened in its browser, including logins, was wiped.</p>
          <Link to="/">← Back home</Link>
        </section>
      </main>
    );

  const isHost = detail.role === 'host';
  const watchingCount = (detail.members ?? []).filter((m) => m.watching).length;

  return (
    <div className={`tank-layout${collapsed ? ' collapsed' : ''}`}>
      <div className="tank-stage">
        {status === 'open' && src ? (
          <iframe
            className="tank-frame"
            src={src}
            title={`Tank: ${detail.tank.name}`}
            allow="autoplay; fullscreen; clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="tank-filling">
            <div className="bubbles" aria-hidden>
              🫧
            </div>
            <p>Filling the tank…</p>
            <p className="muted small">Starting a fresh browser just for this room. This takes a few seconds.</p>
          </div>
        )}
      </div>

      <div className="tank-rail">
        <button
          className="rail-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="tank-side"
          title={collapsed ? 'Show room panel' : 'Hide room panel'}
        >
          <span aria-hidden>{collapsed ? '‹' : '›'}</span>
          <span className="sr-only">{collapsed ? 'Show room panel' : 'Hide room panel'}</span>
        </button>
        {collapsed && (
          <span className="rail-count" title={`${watchingCount} watching`}>
            <span className="dot on" aria-hidden />
            {watchingCount}
          </span>
        )}
      </div>

      <aside className="tank-side" id="tank-side" hidden={collapsed}>
        <div className="card">
          <div className="card-head">
            <h2>{detail.tank.name}</h2>
            <Link to="/" className="small">
              Home
            </Link>
          </div>
          <p className="muted small">
            {isHost
              ? "You are the host. Others can only control the browser once you hand it over or unlock controls in the browser's menu. Guests (no account) can only watch."
              : asGuest
                ? "You're watching as a guest, so you can't control the browser. Your guest pass ends when you close this page or the Tank is drained."
                : 'The host controls the browser. Ask them to hand you control.'}{' '}
            Logins inside this browser are visible to everyone in the room and are wiped when it's drained.
          </p>
          <Members detail={detail} me={me} tankId={id} isHost={isHost} rel={rel} onChange={load} onFriendsChange={loadRelations} />
        </div>

        {isHost && <InvitePanel tankId={id} detail={detail} rel={rel} onInvited={load} />}

        <div className="card">
          {isHost ? (
            <>
              <button
                className="danger-btn"
                onClick={async () => {
                  if (!confirm('Drain this Tank? The browser and everything in it (logins, history) is destroyed for everyone.')) return;
                  await api.drainTank(id).catch(() => {});
                  load();
                }}
              >
                Drain the Tank
              </button>
              <p className="muted small">Closes automatically after {detail.tank.idleMinutes} minutes with nobody watching.</p>
            </>
          ) : (
            <button
              onClick={async () => {
                if (!confirm(asGuest ? 'Leave? Your guest pass ends and you would need a new link to come back.' : 'Leave this Tank? You may need a new invite to come back.')) return;
                await api.leaveTank(id).catch(() => {});
                if (!asGuest) navigate('/');
              }}
            >
              Leave Tank
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

type Relation = 'friend' | 'sent' | 'received' | 'blocked' | 'none';

function relationTo(rel: Relations | null, userId: string): Relation {
  if (!rel) return 'none';
  if (rel.friends.some((f) => f.id === userId)) return 'friend';
  if (rel.outgoing.some((f) => f.id === userId)) return 'sent';
  if (rel.incoming.some((f) => f.id === userId)) return 'received';
  if (rel.blocked.some((f) => f.id === userId)) return 'blocked';
  return 'none';
}

function Members({
  detail,
  me,
  tankId,
  isHost,
  rel,
  onChange,
  onFriendsChange,
}: {
  detail: TankDetail;
  me: string;
  tankId: string;
  isHost: boolean;
  rel: Relations | null;
  onChange: () => void;
  onFriendsChange: () => void;
}) {
  const members = detail.members ?? [];
  const [menu, setMenu] = useState<{ member: TankMember; x: number; y: number } | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const canBefriend = rel !== null && members.some((m) => m.id !== me && !m.isGuest && relationTo(rel, m.id) === 'none');

  const openMenu = (e: React.MouseEvent<HTMLLIElement>, member: TankMember) => {
    if (member.id === me || member.isGuest || rel === null) return; // own row, guests, and guest viewers keep the browser's menu
    e.preventDefault();
    // The keyboard menu key reports (0,0): anchor to the row instead.
    const r = e.currentTarget.getBoundingClientRect();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    setMenu({ member, x: fromKeyboard ? r.left + 24 : e.clientX, y: fromKeyboard ? r.bottom : e.clientY });
  };

  const befriend = async (m: TankMember, relation: Relation) => {
    setMenu(null);
    try {
      if (relation === 'received') {
        await api.acceptFriend(m.id);
        setNote({ text: `You and ${m.displayName} are now friends.` });
      } else {
        const r = await api.sendFriendRequest(m.username);
        setNote({ text: r.status === 'accepted' ? `You and ${m.displayName} are now friends.` : `Friend request sent to ${m.displayName}.` });
      }
    } catch (e) {
      setNote({ text: e instanceof ApiError ? e.message : 'Could not send the friend request', error: true });
    }
    onFriendsChange();
  };

  return (
    <div className="group">
      <h3>In this Tank ({members.length})</h3>
      {canBefriend && <p className="muted small">Right-click someone to add them as a friend.</p>}
      <ul className="people">
        {members.map((m) => (
          <li key={m.id} onContextMenu={(e) => openMenu(e, m)} tabIndex={m.id === me || m.isGuest || rel === null ? undefined : 0}>
            <span className={`dot ${m.watching ? 'on' : ''}`} title={m.watching ? 'Watching' : 'Not watching'} />
            <Avatar name={m.displayName} url={m.avatarUrl} seed={m.id} />
            <span className="person" title={m.displayName}>
              {m.displayName}
              {m.id === me && <span className="muted small"> (you)</span>}
            </span>
            {m.role === 'host' && <span className="badge">host</span>}
            {m.isGuest && <span className="badge" title="No account: watch only, removed when they leave">guest</span>}
            {isHost && m.role !== 'host' && (
              <button
                className="link danger small"
                onClick={async () => {
                  if (!confirm(`Remove ${m.displayName} from this Tank? Their stream is cut off immediately.${m.isGuest ? ' Their guest pass ends.' : ''}`)) return;
                  await api.removeTankMember(tankId, m.id).catch(() => {});
                  onChange();
                }}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {note && <p className={note.error ? 'error' : 'muted small'}>{note.text}</p>}
      {menu && (
        <FriendMenu
          x={menu.x}
          y={menu.y}
          member={menu.member}
          relation={relationTo(rel, menu.member.id)}
          onAdd={(relation) => befriend(menu.member, relation)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

const MENU_LABELS: Record<Relation, string> = {
  none: 'Add friend',
  received: 'Accept friend request',
  friend: 'Already friends',
  sent: 'Friend request sent',
  blocked: "You blocked them",
};

function FriendMenu({
  x,
  y,
  member,
  relation,
  onAdd,
  onClose,
}: {
  x: number;
  y: number;
  member: TankMember;
  relation: Relation;
  onAdd: (relation: Relation) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    // Keep it on screen, then focus the item so Enter/Escape work.
    const el = ref.current;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(x, innerWidth - width - 8)), top: Math.max(8, Math.min(y, innerHeight - height - 8)) });
      el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Clicks inside the Tank iframe never reach this document; the window losing focus covers them.
    addEventListener('pointerdown', outside, true);
    addEventListener('contextmenu', outside, true);
    addEventListener('keydown', key);
    addEventListener('blur', onClose);
    addEventListener('resize', onClose);
    addEventListener('scroll', onClose, true);
    return () => {
      removeEventListener('pointerdown', outside, true);
      removeEventListener('contextmenu', outside, true);
      removeEventListener('keydown', key);
      removeEventListener('blur', onClose);
      removeEventListener('resize', onClose);
      removeEventListener('scroll', onClose, true);
    };
  }, [x, y]);

  const actionable = relation === 'none' || relation === 'received';
  return (
    <div ref={ref} className="context-menu" role="menu" aria-label={member.displayName} style={pos}>
      <div className="context-menu-title" title={`@${member.username}`}>
        {member.displayName}
      </div>
      <button role="menuitem" disabled={!actionable} aria-disabled={!actionable} onClick={() => onAdd(relation)}>
        {MENU_LABELS[relation]}
      </button>
    </div>
  );
}

function InvitePanel({ tankId, detail, rel, onInvited }: { tankId: string; detail: TankDetail; rel: Relations | null; onInvited: () => void }) {
  const [link, setLink] = useState<{ id: string; link: string; code: string; maxUses: number } | null>(null);
  const [codes, setCodes] = useState<TankCode[]>([]);
  const loadCodes = () => api.tankCodes(tankId).then((r) => setCodes(r.codes), () => {});
  // Members change when someone uses a link, so refresh the use counts with them.
  useEffect(() => {
    loadCodes();
  }, [tankId, detail.members?.length]);
  const [maxUses, setMaxUses] = useState(1);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const memberIds = new Set((detail.members ?? []).map((m) => m.id));
  const pending = new Set(detail.pendingInvitees ?? []);
  const candidates = (rel?.friends ?? []).filter((f) => !memberIds.has(f.id));

  const invite = async (userId: string) => {
    setError('');
    try {
      await api.inviteToTank(tankId, [userId]);
      onInvited();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not invite');
    }
  };

  const makeLink = async () => {
    setError('');
    try {
      setLink(await api.createTankCode(tankId, maxUses));
      setCopied(false);
      loadCodes();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create a link');
    }
  };

  const revoke = async (c: TankCode) => {
    if (!confirm(`Revoke the link ending in ${c.hint ?? '…'}? Nobody new can join with it. People who already joined stay.`)) return;
    setError('');
    try {
      await api.revokeTankCode(tankId, c.id);
      if (link?.id === c.id) setLink(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not revoke');
    }
    loadCodes();
  };

  return (
    <div className="card">
      <h2>Invite</h2>
      <label className="check-row">
        <input
          type="checkbox"
          checked={!!detail.tank.friendsCanJoin}
          onChange={async (e) => {
            setError('');
            try {
              await api.setFriendsCanJoin(tankId, e.target.checked);
              onInvited();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Could not change that');
            }
          }}
        />
        <span>
          Friends can drop in
          <span className="muted small block">
            {detail.tank.friendsCanJoin ? 'Your friends see this Tank on their home page and can join without an invite.' : 'Only people you invite can see or join.'}
          </span>
        </span>
      </label>
      <div className="group">
        <h3>Friends</h3>
        {candidates.length === 0 ? (
          <p className="muted small">{rel && rel.friends.length === 0 ? 'Add friends on the home page first.' : 'All your friends are here.'}</p>
        ) : (
          <ul className="people">
            {candidates.map((f) => (
              <li key={f.id}>
                <span className={`dot ${f.online ? 'on' : ''}`} />
                <Avatar name={f.displayName} url={f.avatarUrl} seed={f.id} size={24} />
                <span className="person" title={f.displayName}>{f.displayName}</span>
                {pending.has(f.id) ? (
                  <span className="muted small">Invited</span>
                ) : (
                  <button className="small-btn" onClick={() => invite(f.id)}>
                    Invite
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="group">
        <h3>Invite link</h3>
        <p className="muted small">Works for people without a FishTank account too: they sign up with it and land in this Tank.</p>
        <div className="row">
          <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} aria-label="How many people can use it">
            <option value={1}>1 person</option>
            <option value={3}>3 people</option>
            <option value={5}>5 people</option>
            <option value={10}>10 people</option>
          </select>
          <button onClick={makeLink}>Create link</button>
        </div>
        {link && (
          <div className="fresh">
            <div className="mono">{link.code}</div>
            <div className="row">
              <input readOnly value={link.link} onFocus={(e) => e.target.select()} className="mono small" />
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(link.link);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p className="muted small">
              Good for {link.maxUses} {link.maxUses === 1 ? 'person' : 'people'}, until the Tank is drained.
            </p>
          </div>
        )}
        {codes.length > 0 && (
          <>
            <h3>Active links</h3>
            <ul className="people">
              {codes.map((c) => (
                <li key={c.id}>
                  <span className="person mono small">…{c.hint ?? '????'}</span>
                  <span className="muted small">
                    {c.uses}/{c.maxUses} used
                  </span>
                  <button className="small-btn" onClick={() => revoke(c)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
