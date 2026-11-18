import { useEffect, useState } from 'react';

/** Re-renders every `ms` while `active`, returning the current time. */
export function useNow(active = true, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/** 0:42, 12:05, 1:02:03 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1 h 20 min", "45 min", "under a minute" */
export function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

export function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "Deletes in 6 days" / "in 5 hours" / "soon" */
export function deletesIn(expiresAt: number | null, now: number): string {
  if (!expiresAt) return '';
  const left = expiresAt - now;
  if (left <= 60 * 60_000) return 'Deletes soon';
  const hours = Math.round(left / 3_600_000);
  if (hours < 36) return `Deletes in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(left / 86_400_000);
  return `Deletes in ${days} days`;
}

/** Red "● REC 12:34" pill; shows the timer's stop time when there is one. */
export function RecBadge({ startedAt, stopAt, compact = false }: { startedAt: number; stopAt?: number | null; compact?: boolean }) {
  const now = useNow();
  return (
    <span className="rec-badge" role="status" title={stopAt ? `Recording · stops at ${timeOfDay(stopAt)}` : 'This Tank is being recorded'}>
      <span className="rec-dot" aria-hidden />
      REC {clock(now - startedAt)}
      {!compact && stopAt && <span className="rec-stop"> · stops {timeOfDay(stopAt)}</span>}
    </span>
  );
}

export type TimerChoice = 'none' | '30' | '60' | '120' | '180' | 'at';

/** Turns a timer choice into a stop time (epoch ms), or an error to show. */
export function stopAtFor(choice: TimerChoice, at: string, now: number, maxEnd: number): { stopAt: number | null } | { error: string } {
  if (choice === 'none') return { stopAt: null };
  let stopAt: number;
  if (choice === 'at') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(at);
    if (!m) return { error: 'Pick a time to stop at.' };
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    // A time that already passed today means tomorrow (e.g. 1:00 AM, picked at 10 PM).
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    stopAt = d.getTime();
  } else {
    stopAt = now + Number(choice) * 60_000;
  }
  if (stopAt - now < 60_000) return { error: 'Pick a time at least a minute from now.' };
  if (stopAt > maxEnd) return { error: `That's past the longest a recording can run (until ${timeOfDay(maxEnd)}).` };
  return { stopAt };
}

/** "Stop: no timer / after 30 min / … / at a time" with a time field for the last one. */
export function TimerPicker({
  choice,
  at,
  onChoice,
  onAt,
  label = 'Stop',
}: {
  choice: TimerChoice;
  at: string;
  onChoice: (c: TimerChoice) => void;
  onAt: (t: string) => void;
  label?: string;
}) {
  return (
    <div className="row timer-row">
      <label className="timer-label">
        <span className="muted small">{label}</span>
        <select value={choice} onChange={(e) => onChoice(e.target.value as TimerChoice)}>
          <option value="none">No timer</option>
          <option value="30">After 30 min</option>
          <option value="60">After 1 hour</option>
          <option value="120">After 2 hours</option>
          <option value="180">After 3 hours</option>
          <option value="at">At a time…</option>
        </select>
      </label>
      {choice === 'at' && <input type="time" value={at} onChange={(e) => onAt(e.target.value)} aria-label="Stop at" required />}
    </div>
  );
}
