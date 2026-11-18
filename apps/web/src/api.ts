export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUrl: string | null;
  /** Set for temporary guests: the one Tank they can watch. */
  guestTankId: string | null;
}

/** Optional features this person can use. */
export interface Features {
  recordings: boolean;
}

export interface RegistrationCode {
  id: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  usedBy: string | null;
  createdBy: string | null;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}
export interface Friend extends UserSummary {
  online: boolean;
  /** Watching a Tank right now; id and name only if you could see that Tank yourself. */
  inTank: { id: string | null; name: string | null } | null;
  since: number | null;
}
export interface PendingRequest extends UserSummary {
  sentAt: number;
}
export interface Relations {
  friends: Friend[];
  incoming: PendingRequest[];
  outgoing: PendingRequest[];
  blocked: UserSummary[];
}

export type TankStatus = 'starting' | 'open' | 'closed';

export interface TankListItem {
  id: string;
  name: string;
  status: TankStatus;
  role: 'host' | 'guest';
  hostId: string;
  hostUsername: string;
  hostDisplayName: string;
  memberCount: number;
  viewerCount: number;
  createdAt: number;
  expiresAt: number;
  /** When the screen preview was taken (null = none yet). */
  previewAt: number | null;
  /** Being recorded right now. */
  recording?: boolean;
}

/** A live Tank hosted by a friend that you can drop in to. */
export interface FriendTank {
  id: string;
  name: string;
  status: TankStatus;
  hostId: string;
  hostUsername: string;
  hostDisplayName: string;
  hostAvatarUrl: string | null;
  memberCount: number;
  viewerCount: number;
  createdAt: number;
  expiresAt: number;
  /** When the screen preview was taken (null = none yet). */
  previewAt: number | null;
  /** Being recorded right now. */
  recording?: boolean;
}

export interface TankMember extends UserSummary {
  role: 'host' | 'guest';
  /** A temporary guest (no account, watch only). */
  isGuest: boolean;
  joinedAt: number;
  watching: boolean;
  online: boolean;
}

export interface TankDetail {
  tank: {
    id: string;
    name: string;
    status: TankStatus;
    hostId?: string;
    createdAt?: number;
    expiresAt?: number;
    idleMinutes?: number;
    friendsCanJoin?: boolean;
    closeReason?: string | null;
  };
  role?: 'host' | 'guest';
  members?: TankMember[];
  pendingInvitees?: string[];
  /** null/absent when recording is turned off on this server. */
  recording?: TankRecording | null;
  embedUrl?: string | null;
}

export interface TankRecording {
  /** You may start/stop/time recordings here (an admin). */
  canRecord: boolean;
  /** False for Tanks opened before recording was turned on. */
  supported: boolean;
  active: { id: string; startedBy: string; startedAt: number; stopAt: number | null } | null;
  /** Longest recording, in hours. */
  maxHours: number;
  /** Days a recording is kept after it ends. */
  keepDays: number;
  /** You may clip the last minute while it's recorded (accounts, not guests). */
  canClip: boolean;
  /** Length of a clip, in seconds. */
  clipSeconds: number;
  /** You may share recordings to play in this Tank (accounts, not guests). */
  canShare: boolean;
  /** The Tank-side Recordings page, as typed in the Tank's address bar. */
  tankUrl: string;
  /** Recordings shared to this Tank, most recent first. */
  shared: SharedRecording[];
}

export interface SharedRecording {
  id: string;
  tankName: string;
  startedBy: string;
  startedAt: number;
  durationMs: number | null;
  expiresAt: number | null;
  parts: Array<{ index: number; durationMs: number }>;
  sharedBy: string;
  sharedAt: number;
}

export interface Recording {
  id: string;
  tankName: string;
  /** A clip is the last minute of a recording, saved by someone in the Tank. */
  kind: 'recording' | 'clip';
  /** Who recorded it (for clips: who clipped it). */
  startedBy: string;
  status: 'recording' | 'processing' | 'ready';
  startedAt: number;
  endedAt: number | null;
  /** When it's wiped (set once it ends). */
  expiresAt: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  parts: Array<{ index: number; durationMs: number; sizeBytes: number }>;
}

export interface RecordingStorage {
  usedBytes: number;
  freeBytes: number | null;
  keepDays: number;
  minFreeGb: number;
}

/** A working TANK- invite link (only its last 4 characters are kept). */
export interface TankCode {
  id: string;
  hint: string | null;
  maxUses: number;
  uses: number;
  createdAt: number;
  expiresAt: number;
}

export interface TankInvite {
  id: string;
  createdAt: number;
  tankId: string;
  tankName: string;
  tankStatus: TankStatus;
  byId: string | null;
  byUsername: string | null;
  byDisplayName: string | null;
}

export interface AdminOverview {
  tanks: Array<{
    id: string;
    name: string;
    status: TankStatus;
    udpPort: number;
    createdAt: number;
    expiresAt: number;
    lastActiveAt: number;
    hostUsername: string;
    hostDisplayName: string;
    memberCount: number;
    viewerCount: number;
    stats: { cpuPercent: number; memoryMb: number } | null;
    /** Set while the Tank is being recorded. */
    recordingId?: string | null;
  }>;
  users: AdminUser[];
  guests: AdminUser[];
  invites: Array<{
    id: string;
    kind: 'account' | 'guest';
    userId: string | null;
    userName: string;
    invitedByName: string | null;
    tankName: string | null;
    createdAt: number;
    endedAt: number | null;
    endReason: string | null;
  }>;
  limits: { maxTanks: number; cpusPerTank: number; memoryGbPerTank: number };
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  avatarUrl: string | null;
  disabled: boolean;
  totp: boolean;
  online: boolean;
  sessions: number;
  createdAt: number;
  lastSeenAt: number | null;
  invitedBy: string | null;
  guestTankId: string | null;
  guestTankName: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error ?? (res.status === 429 ? 'Too many attempts, try again later' : `Request failed (${res.status})`);
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User; features?: Features }>('GET', '/me'),
  login: (username: string, password: string, code?: string) =>
    request<{ user: User }>('POST', '/auth/login', code ? { username, password, code } : { username, password }),
  register: (b: { username: string; displayName: string; password: string; code: string }) =>
    request<{ user: User }>('POST', '/auth/register', b),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  listCodes: (all = false) => request<{ codes: RegistrationCode[] }>('GET', all ? '/registration-codes?all=1' : '/registration-codes'),
  createCode: (note?: string) =>
    request<{ id: string; code: string; expiresAt: number }>('POST', '/registration-codes', note ? { note } : {}),
  revokeCode: (id: string) => request<{ ok: true }>('DELETE', `/registration-codes/${id}`),

  relations: () => request<Relations>('GET', '/friends'),
  sendFriendRequest: (username: string) => request<{ status: 'pending' | 'accepted' }>('POST', '/friends/requests', { username }),
  acceptFriend: (userId: string) => request<{ ok: true }>('POST', `/friends/requests/${userId}/accept`, {}),
  /** Decline incoming or cancel outgoing. */
  dropRequest: (userId: string) => request<{ ok: true }>('DELETE', `/friends/requests/${userId}`),
  removeFriend: (userId: string) => request<{ ok: true }>('DELETE', `/friends/${userId}`),
  block: (userId: string) => request<{ ok: true }>('POST', '/blocks', { userId }),
  unblock: (userId: string) => request<{ ok: true }>('DELETE', `/blocks/${userId}`),

  tanks: () => request<{ tanks: TankListItem[] }>('GET', '/tanks'),
  createTank: (name: string) => request<{ tank: { id: string; name: string; status: TankStatus } }>('POST', '/tanks', { name }),
  friendsTanks: () => request<{ tanks: FriendTank[] }>('GET', '/tanks/friends'),
  joinFriendTank: (id: string) => request<{ tankId: string }>('POST', `/tanks/${id}/join`, {}),
  setFriendsCanJoin: (id: string, friendsCanJoin: boolean) => request<{ ok: true }>('PATCH', `/tanks/${id}`, { friendsCanJoin }),
  tank: (id: string) => request<TankDetail>('GET', `/tanks/${id}`),
  drainTank: (id: string) => request<{ ok: true }>('DELETE', `/tanks/${id}`),
  leaveTank: (id: string) => request<{ ok: true }>('POST', `/tanks/${id}/leave`, {}),
  inviteToTank: (id: string, userIds: string[]) => request<{ invited: number }>('POST', `/tanks/${id}/invites`, { userIds }),
  createTankCode: (id: string, maxUses: number) =>
    request<{ id: string; code: string; link: string; expiresAt: number; maxUses: number }>('POST', `/tanks/${id}/codes`, { maxUses }),
  tankCodes: (id: string) => request<{ codes: TankCode[] }>('GET', `/tanks/${id}/codes`),
  revokeTankCode: (id: string, codeId: string) => request<{ ok: true }>('DELETE', `/tanks/${id}/codes/${codeId}`),
  tankInvites: () => request<{ invites: TankInvite[] }>('GET', '/tank-invites'),
  acceptTankInvite: (id: string) => request<{ tankId: string }>('POST', `/tank-invites/${id}/accept`, {}),
  declineTankInvite: (id: string) => request<{ ok: true }>('POST', `/tank-invites/${id}/decline`, {}),
  tankCodeInfo: (code: string) =>
    request<{ tankName: string; host: string; recording?: boolean }>('GET', `/tank-codes/${encodeURIComponent(code)}`),
  joinAsGuest: (code: string) => request<{ tankId: string }>('POST', `/tank-codes/${encodeURIComponent(code)}/guest`, {}),
  redeemTankCode: (code: string) => request<{ tankId: string }>('POST', '/tank-codes/redeem', { code }),
  removeTankMember: (id: string, userId: string) => request<{ ok: true }>('DELETE', `/tanks/${id}/members/${userId}`),

  /** stopAt: epoch ms to stop automatically, null = no timer. */
  startRecording: (tankId: string, stopAt: number | null) =>
    request<{ recording: { id: string; startedAt: number; stopAt: number | null } }>('POST', `/tanks/${tankId}/recording`, { stopAt }),
  setRecordingTimer: (tankId: string, stopAt: number | null) => request<{ recording: { id: string; stopAt: number | null } }>('PATCH', `/tanks/${tankId}/recording`, { stopAt }),
  stopRecording: (tankId: string) => request<{ ok: true }>('DELETE', `/tanks/${tankId}/recording`),
  recordings: () => request<{ recordings: Recording[]; storage: RecordingStorage | null }>('GET', '/recordings'),
  deleteRecording: (id: string) => request<{ ok: true }>('DELETE', `/recordings/${id}`),
  clip: (tankId: string) => request<{ clip: { id: string; durationMs: number; sizeBytes: number } }>('POST', `/tanks/${tankId}/clip`),
  shareRecording: (tankId: string, recordingId: string) => request<{ ok: true }>('POST', `/tanks/${tankId}/playback`, { recordingId }),
  unshareRecording: (tankId: string, recordingId: string) => request<{ ok: true }>('DELETE', `/tanks/${tankId}/playback/${recordingId}`),

  adminOverview: () => request<AdminOverview>('GET', '/admin/overview'),
  disableUser: (id: string) => request<{ ok: true }>('POST', `/admin/users/${id}/disable`, {}),
  enableUser: (id: string) => request<{ ok: true }>('POST', `/admin/users/${id}/enable`, {}),

  uploadAvatar: (image: string) => request<{ avatarUrl: string }>('PUT', '/account/avatar', { image }),
  deleteAvatar: () => request<{ ok: true }>('DELETE', '/account/avatar'),

  security: () => request<{ totpEnabled: boolean; recoveryCodesLeft: number }>('GET', '/account/security'),
  setup2fa: (password: string) => request<{ secret: string; otpauthUrl: string }>('POST', '/account/2fa/setup', { password }),
  enable2fa: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/account/2fa/enable', { code }),
  disable2fa: (password: string, code: string) => request<{ ok: true }>('POST', '/account/2fa/disable', { password, code }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; signedOutSessions: number }>('POST', '/account/password', { currentPassword, newPassword }),
};
