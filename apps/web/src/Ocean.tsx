import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { matchRoute, usePath } from './router.tsx';

/*
 * The backdrop: a crowded coral reef in shadow, lit up wherever a random shaft of sunlight
 * falls on it, with fish hovering over it, schools in the distance, marine snow and bubbles.
 *
 * How it's drawn (cheap per frame, however detailed the reef):
 * - The reef is generated once from a fixed seed (the same reef every visit) and rendered
 *   ONCE into two images: everything in shadow, and everything lit in its real colours.
 *   Only a resize or a light/dark switch renders them again.
 * - Each frame, a small low-resolution canvas gets the light shafts (scaled up, they come out
 *   soft-edged for free). That mask cuts the lit image out where the light falls, on top of
 *   the shadow image, and also draws the visible beams in the water.
 * - Fish are drawn on the same canvas each frame; each one faces the way it is moving.
 */

const W = 1600;
const H = 900;
const TAU = Math.PI * 2;
const UP = -Math.PI / 2;

/** Small deterministic RNG (mulberry32): the same reef every time. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => n.toFixed(1);

/* ======================================================================================
   Reef generation (SVG markup)
   ====================================================================================== */

type Tone = 'base' | 'shade' | 'hi';
interface Part {
  tone: Tone;
  mode: 'fill' | 'stroke';
  d: string;
  width?: number;
  /** Overrides the item's colour (e.g. an anemone's body vs its tentacles). */
  color?: string;
}
interface Item {
  parts: Part[];
  color: string;
  y: number;
}

/** Collects path data per tone/mode/width/colour, so each piece is a handful of SVG paths. */
class Parts {
  private map = new Map<string, Part>();
  add(tone: Tone, mode: 'fill' | 'stroke', d: string, width?: number, color?: string) {
    const w = width === undefined ? undefined : Math.max(0.5, +width.toFixed(1));
    const key = `${tone}|${mode}|${w ?? ''}|${color ?? ''}`;
    const p = this.map.get(key);
    if (p) p.d += ` ${d}`;
    else this.map.set(key, { tone, mode, d, width: w, color });
  }
  list(): Part[] {
    const order: Tone[] = ['base', 'shade', 'hi'];
    return [...this.map.values()].sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone));
  }
}

const circle = (cx: number, cy: number, rad: number) =>
  `M${f(cx - rad)} ${f(cy)}a${f(rad)} ${f(rad)} 0 1 0 ${f(2 * rad)} 0a${f(rad)} ${f(rad)} 0 1 0 ${f(-2 * rad)} 0`;

/** A tapered segment (w0 → w1) with a rounded joint at its end. */
function taper(x0: number, y0: number, x1: number, y1: number, w0: number, w1: number) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const nx = -Math.sin(a);
  const ny = Math.cos(a);
  return (
    `M${f(x0 + (nx * w0) / 2)} ${f(y0 + (ny * w0) / 2)}L${f(x1 + (nx * w1) / 2)} ${f(y1 + (ny * w1) / 2)}` +
    `L${f(x1 - (nx * w1) / 2)} ${f(y1 - (ny * w1) / 2)}L${f(x0 - (nx * w0) / 2)} ${f(y0 - (ny * w0) / 2)}Z${circle(x1, y1, w1 / 2)}`
  );
}

/** Smooth path through points (quadratic curves through the midpoints). */
function smooth(pts: Array<[number, number]>) {
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d}L${f(last[0])} ${f(last[1])}`;
}

const PALETTES = {
  bigTable: ['#6fb7a8', '#8fb07a', '#7aa0b8', '#9a9d7a'],
  table: ['#7fd6c6', '#a9d47a', '#c9c27a', '#8fb8ff'],
  staghorn: ['#ff9a5a', '#e8b06a', '#c08cff', '#7fb2ff', '#ff7fbf'],
  bush: ['#e8d49a', '#d9c27a', '#c7a0e0', '#9fd0a0', '#f0b080'],
  cluster: ['#e08aa8', '#c98ab8', '#d9c48a', '#b8d48a', '#e8a07a'],
  mound: ['#9a8ab8', '#b88aa0', '#8aa0a8', '#a8a07a', '#c09080', '#7fa88f'],
  brain: ['#e8c76a', '#9be07a', '#d9a06a', '#c9a0ff'],
  fan: ['#d0457f', '#ff6f91', '#b05cff', '#ffb347'],
  soft: ['#ffc83d', '#ffb02e', '#ff9a3d', '#ffd84a'],
  tubes: ['#c08cff', '#ff7fbf', '#ff9a5a', '#3fd6c6'],
  anemone: ['#c9d46a', '#b8c860', '#d8d880', '#a8c070'],
  rock: ['#8a99a3', '#9c9a8f', '#7f8d96'],
  star: ['#ff7043', '#ff5c8a', '#ffb347'],
} as const;
type Species = keyof typeof PALETTES;
type Grow = (r: () => number, x: number, y: number, s: number) => Part[];

/** Branching coral: tapered, gently curving limbs with lit polyp tips. */
function branching(r: () => number, x: number, y: number, s: number, o: { len: number; w: number; depth: number; kids: number; spread: number }) {
  const P = new Parts();
  const grow = (x0: number, y0: number, ang: number, len: number, w: number, depth: number) => {
    let px = x0;
    let py = y0;
    let a = ang;
    let wc = w;
    for (let i = 1; i <= 2; i++) {
      a += (r() - 0.5) * 0.3;
      const nx = px + (Math.cos(a) * len) / 2;
      const ny = py + (Math.sin(a) * len) / 2;
      const w1 = w * (1 - 0.14 * i);
      P.add('base', 'fill', taper(px, py, nx, ny, wc, w1));
      px = nx;
      py = ny;
      wc = w1;
    }
    if (depth >= o.depth || wc < 1.6 * s) {
      P.add('hi', 'fill', circle(px, py, wc * 0.6));
      return;
    }
    const kids = o.kids + (r() < 0.35 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const spread = (k - (kids - 1) / 2) * (o.spread + r() * 0.3) + (r() - 0.5) * 0.2;
      grow(px, py, (a + spread) * 0.8 + UP * 0.2, len * (0.7 + r() * 0.14), wc * 0.8, depth + 1);
    }
  };
  const trunks = 1 + Math.floor(r() * 3);
  for (let t = 0; t < trunks; t++) {
    grow(x + (t - (trunks - 1) / 2) * o.w * 0.8, y + 3, UP + (t - (trunks - 1) / 2) * 0.4 + (r() - 0.5) * 0.3, o.len * (0.8 + r() * 0.4), o.w, 0);
  }
  return P.list();
}
const staghorn: Grow = (r, x, y, s) => branching(r, x, y, s, { len: 30 * s, w: 10 * s, depth: 4, kids: 2, spread: 0.55 });
/** Bottlebrush acropora: a dense bush of short branches ending in many tips. */
const bush: Grow = (r, x, y, s) => branching(r, x, y, s, { len: 14 * s, w: 7 * s, depth: 5, kids: 3, spread: 0.45 });

/** Finger / cauliflower coral: a packed dome of short knobbly fingers. */
const cluster: Grow = (r, x, y, s) => {
  const P = new Parts();
  const R = (18 + r() * 26) * s;
  const n = Math.round(14 + R / s);
  const fingers: Array<[number, number, number, number, number]> = [];
  for (let k = 0; k < n; k++) {
    const a = Math.PI + (k / (n - 1)) * Math.PI + (r() - 0.5) * 0.25;
    const inner = R * (0.15 + r() * 0.35);
    const bx = x + Math.cos(a) * inner;
    const by = y + Math.sin(a) * inner * 0.7;
    const len = R * (0.55 + r() * 0.45);
    const aa = a * 0.65 + UP * 0.35;
    fingers.push([bx, by, bx + Math.cos(aa) * len, by + Math.sin(aa) * len, (5 + r() * 3) * s]);
  }
  fingers.sort((p, q) => q[3] - p[3]); // back (higher) fingers first
  P.add('shade', 'fill', `M${f(x - R)} ${f(y + 3)}Q${f(x)} ${f(y - R * 1.1)} ${f(x + R)} ${f(y + 3)}Z`);
  for (const [bx, by, ex, ey, w] of fingers) {
    P.add('base', 'fill', taper(bx, by, ex, ey, w * 1.1, w));
    P.add('hi', 'fill', circle(ex - w * 0.12, ey - w * 0.12, w * 0.28));
  }
  return P.list();
};

/** Massive / encrusting coral: a lumpy mound covered in polyp pits. */
const mound: Grow = (r, x, y, s) => {
  const P = new Parts();
  const w = (16 + r() * 34) * s;
  const lumps = 4 + Math.floor(r() * 5);
  let top = y;
  for (let k = 0; k < lumps; k++) {
    const t = k / (lumps - 1);
    const rad = (0.45 + r() * 0.35) * w * (1 - Math.abs(t - 0.5) * 0.9);
    const cx = x - w + t * 2 * w;
    const cy = y + 3 - Math.sin(t * Math.PI) * w * 0.35;
    P.add('base', 'fill', circle(cx, cy, rad));
    top = Math.min(top, cy - rad);
  }
  for (let i = 0; i < w / (2.2 * s); i++) {
    const px = x + (r() - 0.5) * w * 1.7;
    P.add('shade', 'fill', circle(px, y - r() * (y - top) * 0.85, 0.8 * s + r() * 0.8 * s));
  }
  P.add('hi', 'stroke', `M${f(x - w * 0.5)} ${f(top + w * 0.25)}Q${f(x)} ${f(top - 2)} ${f(x + w * 0.4)} ${f(top + w * 0.2)}`, 2.4 * s);
  return P.list();
};

/** Brain coral: a smooth dome with meandering grooves. */
const brain: Grow = (r, x, y, s) => {
  const P = new Parts();
  const w = (22 + r() * 26) * s;
  const h = w * (0.6 + r() * 0.25);
  P.add('base', 'fill', `M${f(x - w)} ${f(y + 3)}C${f(x - w)} ${f(y - h * 1.33)} ${f(x + w)} ${f(y - h * 1.33)} ${f(x + w)} ${f(y + 3)}Z`);
  for (let k = 1; k <= 5; k++) {
    const sc = 1 - k * 0.16;
    const phase = r() * TAU;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 22; i++) {
      const t = 0.1 * Math.PI + (i / 22) * 0.8 * Math.PI;
      const wig = Math.sin(t * 14 + phase) * 2 * s;
      pts.push([x - Math.cos(t) * (w * 0.92 * sc + wig), y - Math.sin(t) * (h * 0.95 * sc + wig) + 2]);
    }
    P.add('shade', 'stroke', smooth(pts), 1.3 * s);
  }
  P.add('hi', 'stroke', `M${f(x - w * 0.55)} ${f(y - h * 0.62)}Q${f(x - w * 0.15)} ${f(y - h * 1.02)} ${f(x + w * 0.25)} ${f(y - h * 0.86)}`, 2.6 * s);
  return P.list();
};

/** Table coral: trunk under stacked flat plates with fringed, scalloped rims. */
function tables(r: () => number, x: number, y: number, s: number, big: boolean) {
  const P = new Parts();
  const th = (big ? 40 + r() * 40 : 24 + r() * 26) * s;
  P.add('base', 'fill', taper(x, y + 3, x + (r() - 0.5) * 6 * s, y - th, (big ? 22 : 12) * s, (big ? 12 : 7) * s));
  const tiers = big ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2);
  for (let t = 0; t < tiers; t++) {
    const pw = (big ? 110 + r() * 110 : 40 + r() * 34) * s * (1 - t * 0.2);
    const cx = x + (r() - 0.5) * (big ? 60 : 16) * s;
    const ty = y - th - t * (big ? 22 + r() * 14 : 12 + r() * 8) * s;
    const thick = (big ? 10 : 6) * s;
    let d = `M${f(cx - pw)} ${f(ty)}Q${f(cx)} ${f(ty - (big ? 16 : 9) * s)} ${f(cx + pw)} ${f(ty)}`;
    const n = Math.round(pw / (8 * s));
    for (let k = 1; k <= n; k++) {
      const x1 = cx + pw - (2 * pw * k) / n;
      d += `Q${f(x1 + pw / n)} ${f(ty + thick + 3 * s)} ${f(x1)} ${f(ty + thick * 0.6)}`;
    }
    P.add('base', 'fill', `${d}Z`);
    P.add('shade', 'stroke', `M${f(cx - pw * 0.92)} ${f(ty + thick * 0.75)}Q${f(cx)} ${f(ty + thick * 1.15)} ${f(cx + pw * 0.92)} ${f(ty + thick * 0.75)}`, 2.2 * s);
    P.add('hi', 'stroke', `M${f(cx - pw * 0.85)} ${f(ty - 1)}Q${f(cx)} ${f(ty - (big ? 16 : 9) * s)} ${f(cx + pw * 0.85)} ${f(ty - 1)}`, 1.6 * s);
    // Fringe of tiny branchlets along the rim and top.
    for (let bx = cx - pw * 0.95; bx < cx + pw * 0.95; bx += (3 + r() * 3) * s) {
      const by = ty - (big ? 14 : 8) * s * (1 - ((bx - cx) / pw) ** 2) * 0.55 - 1;
      P.add('base', 'stroke', `M${f(bx)} ${f(by)}l${f((r() - 0.5) * 2 * s)} ${f(-(2 + r() * 4) * s)}`, 1.4 * s);
    }
  }
  return P.list();
}
const table: Grow = (r, x, y, s) => tables(r, x, y, s, false);
const bigTable: Grow = (r, x, y, s) => tables(r, x, y, s, true);

/** Gorgonian sea fan: a flat fan of branches with a fine net between them. */
const fan: Grow = (r, x, y, s) => {
  const P = new Parts();
  const widths = [4.5, 3.2, 2.4, 1.8, 1.3, 1];
  const nodes: Array<{ x: number; y: number; d: number; a: number }> = [];
  const lean = (r() - 0.5) * 0.35;
  const grow = (x0: number, y0: number, ang: number, len: number, depth: number) => {
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 + Math.sin(ang) * len;
    P.add('base', 'stroke', `M${f(x0)} ${f(y0)}Q${f((x0 + x1) / 2 + (r() - 0.5) * len * 0.25)} ${f((y0 + y1) / 2)} ${f(x1)} ${f(y1)}`, widths[depth]! * s);
    nodes.push({ x: x1, y: y1, d: depth, a: Math.atan2(y1 - y, x1 - x) });
    if (depth >= 5) return;
    const split = 0.22 + r() * 0.22;
    grow(x1, y1, ang - split, len * (0.78 + r() * 0.1), depth + 1);
    grow(x1, y1, ang + split, len * (0.78 + r() * 0.1), depth + 1);
  };
  grow(x, y + 3, UP + lean, (20 + r() * 10) * s, 0);
  for (let d = 2; d <= 5; d++) {
    const ring = nodes.filter((n) => n.d === d).sort((a, b) => a.a - b.a);
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1]!;
      const b = ring[i]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 32 * s) continue;
      P.add('shade', 'stroke', `M${f(a.x)} ${f(a.y)}Q${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2 - 3 * s)} ${f(b.x)} ${f(b.y)}`, 0.8 * s);
    }
  }
  for (const n of nodes) if (n.d === 5) P.add('hi', 'fill', circle(n.x, n.y, 1.1 * s));
  return P.list();
};

/** Soft coral: a lacy ball of fine twigs (the bright yellow bushes). */
const soft: Grow = (r, x, y, s) => {
  const P = new Parts();
  const grow = (x0: number, y0: number, ang: number, len: number, depth: number) => {
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 + Math.sin(ang) * len;
    P.add(depth > 3 ? 'hi' : 'base', 'stroke', `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}`, Math.max(0.7, 3.2 - depth * 0.55) * s);
    if (depth >= 5) return;
    const kids = 2 + (r() < 0.5 ? 1 : 0);
    for (let k = 0; k < kids; k++) grow(x1, y1, ang + (r() - 0.5) * 1.6, len * (0.62 + r() * 0.2), depth + 1);
  };
  const stems = 3 + Math.floor(r() * 3);
  for (let k = 0; k < stems; k++) grow(x + (r() - 0.5) * 8 * s, y + 3, UP + (r() - 0.5) * 1.6, (12 + r() * 10) * s, 0);
  return P.list();
};

/** Tube sponges: leaning tubes with open, rimmed mouths. */
const tubes: Grow = (r, x, y, s) => {
  const P = new Parts();
  const n = 2 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const w = (8 + r() * 6) * s;
    const h = (26 + r() * 46) * s;
    const bx = x + (k - (n - 1) / 2) * w * 0.9;
    const lean = (bx - x) * 0.25 + (r() - 0.5) * 8 * s;
    const tx = bx + lean;
    const ty = y - h;
    P.add('base', 'fill', `M${f(bx - w * 0.4)} ${f(y + 3)}Q${f(bx - w * 0.55 + lean * 0.4)} ${f(y - h / 2)} ${f(tx - w / 2)} ${f(ty)}L${f(tx + w / 2)} ${f(ty)}Q${f(bx + w * 0.55 + lean * 0.4)} ${f(y - h / 2)} ${f(bx + w * 0.4)} ${f(y + 3)}Z`);
    P.add('base', 'fill', `M${f(tx - w / 2)} ${f(ty)}a${f(w / 2)} ${f(w / 5)} 0 1 0 ${f(w)} 0a${f(w / 2)} ${f(w / 5)} 0 1 0 ${f(-w)} 0`);
    P.add('shade', 'fill', `M${f(tx - w * 0.36)} ${f(ty)}a${f(w * 0.36)} ${f(w / 7.5)} 0 1 0 ${f(w * 0.72)} 0a${f(w * 0.36)} ${f(w / 7.5)} 0 1 0 ${f(-w * 0.72)} 0`);
    P.add('hi', 'stroke', `M${f(bx - w * 0.2)} ${f(y - 2)}Q${f(bx - w * 0.28 + lean * 0.4)} ${f(y - h / 2)} ${f(tx - w * 0.28)} ${f(ty + w * 0.3)}`, w * 0.14);
  }
  return P.list();
};

/** Anemone: a purple body under a mop of long curling tentacles. */
const anemone: Grow = (r, x, y, s) => {
  const P = new Parts();
  const R = (22 + r() * 16) * s;
  const body = ['#a05cd0', '#c060a0', '#8a5cd0'][Math.floor(r() * 3)]!;
  P.add('base', 'fill', `M${f(x - R)} ${f(y + 3)}C${f(x - R * 1.1)} ${f(y - R * 1.1)} ${f(x + R * 1.1)} ${f(y - R * 1.1)} ${f(x + R)} ${f(y + 3)}Z`, undefined, body);
  P.add('hi', 'stroke', `M${f(x - R * 0.6)} ${f(y - R * 0.45)}Q${f(x)} ${f(y - R * 0.85)} ${f(x + R * 0.5)} ${f(y - R * 0.5)}`, 3 * s, '#e0a0ff');
  const n = 46 + Math.floor(r() * 30);
  for (let k = 0; k < n; k++) {
    const a = Math.PI + r() * Math.PI;
    const ox = x + Math.cos(a) * R * 0.75;
    const oy = y - R * 0.55 + Math.sin(a) * R * 0.35;
    const out = Math.atan2(oy - (y + R * 0.2), ox - x);
    const len = (22 + r() * 30) * s;
    const pts: Array<[number, number]> = [[ox, oy]];
    let ang = out + (r() - 0.5) * 0.6;
    let px = ox;
    let py = oy;
    for (let i = 0; i < 4; i++) {
      ang += (r() - 0.5) * 1.2;
      px += (Math.cos(ang) * len) / 4;
      py += (Math.sin(ang) * len) / 4;
      pts.push([px, py]);
    }
    P.add(k % 4 ? 'base' : 'hi', 'stroke', smooth(pts), 2.2 * s);
  }
  return P.list();
};

/** A rounded rock or chunk of rubble. */
const rock: Grow = (r, x, y, s) => {
  const P = new Parts();
  const w = (10 + r() * 22) * s;
  const h = w * (0.45 + r() * 0.3);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 10; i++) {
    const t = (i / 10) * Math.PI;
    const k = 0.85 + r() * 0.25;
    pts.push([x - Math.cos(t) * w * k, y + 4 - Math.sin(t) * h * k]);
  }
  P.add('base', 'fill', `${smooth(pts)}Z`);
  for (let i = 0; i < 6; i++) P.add('shade', 'fill', circle(x + (r() - 0.5) * w * 1.4, y + 2 - r() * h * 0.7, 1 * s));
  P.add('hi', 'stroke', `M${f(x - w * 0.55)} ${f(y + 4 - h * 0.55)}Q${f(x - w * 0.1)} ${f(y + 4 - h)} ${f(x + w * 0.3)} ${f(y + 4 - h * 0.8)}`, 1.8 * s);
  return P.list();
};

/** A small starfish. */
const star: Grow = (r, x, y, s) => {
  const P = new Parts();
  const R = (6 + r() * 4) * s;
  const rot = r() * TAU;
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5;
    const rad = i % 2 ? R * 0.42 : R;
    d += `${i ? 'L' : 'M'}${f(x + Math.cos(a) * rad)} ${f(y + Math.sin(a) * rad * 0.55)}`;
  }
  P.add('base', 'fill', `${d}Z`);
  return P.list();
};

const GROW: Record<Species, Grow> = { bigTable, table, staghorn, bush, cluster, mound, brain, fan, soft, tubes, anemone, rock, star };

interface LayerSpec {
  seed: number;
  /** Seabed height at the left, middle and right (the reef rises toward the middle-left). */
  crest: [number, number, number];
  scale: number;
  /** Average gap between pieces, in px at this layer's scale. */
  gap: number;
  /** How far below the crest pieces are scattered (piles them up the slope). */
  pile: number;
  mix: Partial<Record<Species, number>>;
}

const LAYERS: LayerSpec[] = [
  { seed: 11, crest: [520, 455, 560], scale: 0.5, gap: 16, pile: 60, mix: { bigTable: 1.5, table: 2, mound: 4, cluster: 4, bush: 3, staghorn: 2 } },
  { seed: 23, crest: [590, 530, 615], scale: 0.62, gap: 15, pile: 80, mix: { bigTable: 1.5, table: 2, mound: 4, cluster: 4, bush: 4, staghorn: 2, fan: 1.5 } },
  { seed: 37, crest: [650, 610, 670], scale: 0.8, gap: 15, pile: 90, mix: { table: 2, mound: 4, cluster: 5, bush: 4, staghorn: 3, brain: 2, fan: 2, tubes: 1, soft: 1 } },
  { seed: 41, crest: [745, 720, 760], scale: 1.0, gap: 16, pile: 100, mix: { mound: 4, cluster: 5, bush: 4, staghorn: 2, brain: 3, fan: 2, tubes: 1.5, soft: 2, anemone: 1.5, rock: 1 } },
  { seed: 53, crest: [845, 830, 850], scale: 1.3, gap: 18, pile: 70, mix: { cluster: 5, bush: 4, mound: 4, anemone: 2.5, soft: 2.5, brain: 2, rock: 2, star: 1, fan: 1 } },
];

interface Layer {
  ground: string;
  items: Item[];
  crestAt: (x: number) => number;
  scale: number;
}

function pickSpecies(r: () => number, mix: Partial<Record<Species, number>>): Species {
  const entries = Object.entries(mix) as Array<[Species, number]>;
  let roll = r() * entries.reduce((n, [, w]) => n + w, 0);
  for (const [sp, w] of entries) if ((roll -= w) <= 0) return sp;
  return entries[0]![0];
}

function makeLayer(spec: LayerSpec): Layer {
  const r = rng(spec.seed);
  const [l, m, rt] = spec.crest;
  const s = spec.scale;
  const crestAt = (x: number) => {
    const t = x / W;
    const base = t < 0.45 ? l + (m - l) * Math.sin((t / 0.45) * (Math.PI / 2)) : m + (rt - m) * Math.sin(((t - 0.45) / 0.55) * (Math.PI / 2));
    return base + Math.sin(x / 230 + spec.seed * 0.7) * 28 + Math.sin(x / (120 * s) + spec.seed) * 14 * s + Math.sin(x / 41 + spec.seed * 2) * 5 * s;
  };
  const pts: Array<[number, number]> = [];
  for (let x = -40; x <= W + 40; x += 20) pts.push([x, crestAt(x) + 10 * s]);
  const ground = `${smooth(pts)}L${W + 40} ${H}L-40 ${H}Z`;

  const items: Item[] = [];
  for (let x = -40; x < W + 40; x += spec.gap * s * (0.5 + r())) {
    const sp = pickSpecies(r, spec.mix);
    const y = crestAt(x) + r() ** 1.6 * spec.pile * s;
    const palette = PALETTES[sp];
    items.push({ parts: GROW[sp](r, x, y, s * (0.8 + r() * 0.4)), color: palette[Math.floor(r() * palette.length)]!, y });
  }
  items.sort((a, b) => a.y - b.y); // lower pieces in front
  return { ground, items, crestAt, scale: s };
}

/** Mixes a hex colour toward another (t = 0..1). */
function mix(hex: string, to: string, t: number) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

interface Theme {
  reef: string[]; // shadow colour per layer, far → near
  water: string; // for hazing far colours
  sand: string;
  sunTop: string;
  sunMid: string;
  dark: boolean;
}

const LIT_STRENGTH = [0.32, 0.45, 0.6, 0.75, 0.88];

/** SVG markup for the whole reef, either all in shadow or all lit. */
function reefSvg(layers: Layer[], theme: Theme, lit: boolean, w: number, h: number): string {
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${W} ${H}" stroke-linecap="round" stroke-linejoin="round">`];
  layers.forEach((layer, i) => {
    const shadow = theme.reef[i]!;
    const one = (isLit: boolean) => {
      const g: string[] = [`<path d="${layer.ground}" fill="${isLit ? theme.sand : shadow}"${isLit ? ' opacity="0.3"' : ''}/>`];
      for (const it of layer.items) {
        for (const p of it.parts) {
          const base = p.color ?? it.color;
          // Far layers are hazed toward the water colour even in the light.
          const c = !isLit ? shadow : mix(p.tone === 'base' ? base : p.tone === 'shade' ? mix(base, '#000000', 0.38) : mix(base, '#ffffff', 0.5), theme.water, (4 - i) * 0.09);
          g.push(p.mode === 'fill' ? `<path d="${p.d}" fill="${c}"/>` : `<path d="${p.d}" fill="none" stroke="${c}" stroke-width="${p.width}"/>`);
        }
      }
      return g.join('');
    };
    out.push(`<g>${one(false)}</g>`);
    if (lit) out.push(`<g opacity="${LIT_STRENGTH[i]}">${one(true)}</g>`);
  });
  out.push('</svg>');
  return out.join('');
}

/* ======================================================================================
   Fish
   ====================================================================================== */

/** A fish facing right, about 16 units long, centred on its middle. */
const FISH_PATH = 'M9 0C6 -3.4 1 -3.6 -3.5 -1.3L-7 -3.8L-5.8 0L-7 3.8L-3.5 1.3C1 3.6 6 3.4 9 0Z';

interface Fish {
  kind: 'hover' | 'school';
  x: number;
  y: number;
  size: number;
  color: string;
  ax: number; // hover range (px)
  ay: number;
  wx: number; // speeds (rad/s)
  wy: number;
  ph: number;
  ph2: number;
  speed: number; // schools: px/s (negative = leftward)
}

function makeFish(layers: Layer[], theme: Theme): Fish[] {
  const r = rng(99);
  const fish: Fish[] = [];
  const anthias = ['#ff7b39', '#ff8f4a', '#ff6a4a', '#ff9e5e', '#ff7f6a'];
  // Anthias: a cloud of small orange fish hovering over the reef, thickest near the coral.
  for (let i = 0; i < 130; i++) {
    const li = 1 + Math.floor(r() * 4);
    const layer = layers[li]!;
    const x = r() * W;
    const above = r() ** 2.6 * 170 * layer.scale;
    const depthTint = (4 - li) * 0.12;
    fish.push({
      kind: 'hover',
      x,
      y: layer.crestAt(x) - 10 - above,
      size: (0.95 + r() * 0.65) * layer.scale,
      color: mix(anthias[Math.floor(r() * anthias.length)]!, theme.water, theme.dark ? depthTint + 0.12 : depthTint),
      ax: (8 + r() * 30) * layer.scale,
      ay: (3 + r() * 8) * layer.scale,
      wx: 0.15 + r() * 0.45,
      wy: 0.4 + r() * 0.8,
      ph: r() * TAU,
      ph2: r() * TAU,
      speed: 0,
    });
  }
  // Damselfish: a few bigger dark fish.
  for (let i = 0; i < 9; i++) {
    const layer = layers[2 + Math.floor(r() * 3)]!;
    const x = r() * W;
    fish.push({
      kind: 'hover',
      x,
      y: layer.crestAt(x) - 40 - r() * 180,
      size: (1.4 + r() * 0.8) * layer.scale,
      color: theme.dark ? '#081820' : '#1d3f4c',
      ax: 20 + r() * 50,
      ay: 6 + r() * 10,
      wx: 0.1 + r() * 0.25,
      wy: 0.3 + r() * 0.4,
      ph: r() * TAU,
      ph2: r() * TAU,
      speed: 0,
    });
  }
  // Distant schools crossing the open water.
  for (let sIdx = 0; sIdx < 4; sIdx++) {
    const cy = 120 + r() * 260;
    const speed = (14 + r() * 18) * (sIdx % 2 ? -1 : 1);
    const start = r() * (W + 600);
    for (let i = 0; i < 18 + Math.floor(r() * 18); i++) {
      fish.push({
        kind: 'school',
        x: start + (r() - 0.5) * 220,
        y: cy + (r() - 0.5) * 70,
        size: 0.35 + r() * 0.2,
        color: theme.dark ? '#0d3442' : '#9ec8d6',
        ax: 0,
        ay: 2 + r() * 3,
        wx: 0,
        wy: 0.8 + r(),
        ph: 0,
        ph2: r() * TAU,
        speed,
      });
    }
  }
  return fish;
}

/* ======================================================================================
   Light shafts
   ====================================================================================== */

interface Ray {
  x: number;
  top: number;
  bottom: number;
  tilt: number;
  drift: number;
  born: number; // ms
  dur: number; // ms
  strength: number;
}

function newRay(now: number, age = 0): Ray {
  const top = 30 + Math.random() * 110;
  const dur = (7 + Math.random() * 9) * 1000;
  return {
    x: Math.random() * W,
    top,
    bottom: top * (2 + Math.random() * 1.6),
    tilt: (Math.random() - 0.35) * 320,
    drift: (Math.random() - 0.5) * 120,
    born: now - age * dur,
    dur,
    strength: 0.55 + Math.random() * 0.45,
  };
}

/* ======================================================================================
   The scene
   ====================================================================================== */

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    reef: [0, 1, 2, 3, 4].map((i) => v(`--reef-${i}`, '#06161f')),
    water: v('--bg', '#071a24'),
    sand: v('--reef-sand', '#e8c49a'),
    sunTop: v('--sun-top', 'rgb(190 235 255 / 0.22)'),
    sunMid: v('--sun-mid', 'rgb(150 215 245 / 0.07)'),
    dark: !matchMedia('(prefers-color-scheme: light)').matches,
  };
}

/** Loads an SVG and turns it into a ready-to-blit bitmap, so the first frame drawing it doesn't stall. */
async function loadSvg(svg: string, w: number, h: number): Promise<CanvasImageSource> {
  const img = new Image();
  img.width = w;
  img.height = h;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  try {
    return await createImageBitmap(img); // rasterized off the main thread where the browser can
  } catch {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return c;
  }
}

/** Runs work after the page's own entrance animation (~0.7s), at an idle moment, so it can't stutter it. */
const whenIdle = (fn: () => void): (() => void) => {
  let idle = 0;
  const t = setTimeout(() => {
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(fn, { timeout: 500 });
    else fn();
  }, 750);
  return () => {
    clearTimeout(t);
    if (idle) cancelIdleCallback(idle);
  };
};

/** Starts drawing on the canvas; returns a function that stops it. */
function startScene(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')!;
  // Building the reef is the heavy part: it waits until the page has painted (see whenIdle below).
  let layers: Layer[] | null = null;
  const still = reducedMotion();
  const fishPath = new Path2D(FISH_PATH);
  const mask = document.createElement('canvas');
  const beam = document.createElement('canvas');
  const work = document.createElement('canvas');
  let shadowImg: CanvasImageSource | null = null;
  let litImg: CanvasImageSource | null = null;
  let theme = readTheme();
  let fish: Fish[] = [];
  let running = false;
  let s = 1; // viewBox → device px
  let ox = 0;
  let oy = 0;
  let stopped = false;
  let frame = 0;
  let renderToken = 0;

  const now0 = performance.now();
  let rays: Ray[] = [newRay(now0, 0.35), newRay(now0, 0.55), newRay(now0, 0.2), newRay(now0, 0.45)];
  let nextRay = now0 + 1000;

  const rayLife = (ray: Ray, t: number) => {
    const p = (t - ray.born) / ray.dur;
    if (p <= 0 || p >= 1) return { a: 0, dx: 0 };
    const a = p < 0.22 ? p / 0.22 : p > 0.72 ? (1 - p) / 0.28 : 1;
    return { a: a * ray.strength, dx: ray.drift * (p - 0.5) };
  };

  const drawFish = (t: number, kind: Fish['kind']) => {
    const sec = t / 1000;
    for (const fh of fish) {
      if (fh.kind !== kind) continue;
      let x: number;
      let facing: number;
      if (kind === 'school') {
        const span = W + 600;
        x = ((((fh.x + fh.speed * sec) % span) + span) % span) - 300;
        facing = fh.speed >= 0 ? 1 : -1;
      } else {
        x = fh.x + Math.sin(sec * fh.wx + fh.ph) * fh.ax;
        // Facing follows the direction of travel (the sway's derivative): never backwards.
        facing = Math.cos(sec * fh.wx + fh.ph) >= 0 ? 1 : -1;
      }
      const y = fh.y + Math.sin(sec * fh.wy + fh.ph2) * fh.ay;
      const sc = fh.size * s;
      ctx.setTransform(sc * facing, 0, 0, sc, ox + x * s, oy + y * s);
      ctx.fillStyle = fh.color;
      ctx.fill(fishPath);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  const draw = (t: number) => {
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    // 1. Light shafts into the low-resolution mask.
    const m = mask.getContext('2d')!;
    m.clearRect(0, 0, mask.width, mask.height);
    const k = mask.width / cw;
    m.fillStyle = '#fff';
    // Blurring the tiny mask is cheap, and scaled up it gives the beams wide, soft edges.
    m.filter = 'blur(2.5px)';
    for (const ray of rays) {
      const { a, dx } = still ? { a: ray.strength * 0.8, dx: 0 } : rayLife(ray, t);
      if (a <= 0) continue;
      m.globalAlpha = a;
      const X = (vx: number) => (ox + (vx + dx) * s) * k;
      const Y = (vy: number) => (oy + vy * s) * k;
      m.beginPath();
      m.moveTo(X(ray.x - ray.top / 2), Y(-40));
      m.lineTo(X(ray.x + ray.top / 2), Y(-40));
      m.lineTo(X(ray.x + ray.tilt + ray.bottom / 2), Y(H + 20));
      m.lineTo(X(ray.x + ray.tilt - ray.bottom / 2), Y(H + 20));
      m.closePath();
      m.fill();
    }
    m.globalAlpha = 1;
    m.filter = 'none';

    // 2. Visible beams in the water: a vertical glow cut to the shafts, scaled up (soft edges).
    const b = beam.getContext('2d')!;
    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, beam.width, beam.height);
    const g = b.createLinearGradient(0, 0, 0, beam.height);
    g.addColorStop(0, theme.sunTop);
    g.addColorStop(0.7, theme.sunMid);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, beam.width, beam.height);
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(mask, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(beam, 0, 0, cw, ch);

    // 3. Distant schools, behind the reef.
    drawFish(t, 'school');

    // 4. The reef in shadow, then lit wherever the shafts fall.
    if (shadowImg && litImg) {
      ctx.drawImage(shadowImg, ox, oy);
      const wctx = work.getContext('2d')!;
      wctx.globalCompositeOperation = 'source-over';
      wctx.clearRect(0, 0, cw, ch);
      wctx.drawImage(litImg, ox, oy);
      wctx.globalCompositeOperation = 'destination-in';
      wctx.imageSmoothingQuality = 'high';
      wctx.drawImage(mask, 0, 0, cw, ch);
      ctx.drawImage(work, 0, 0);
    }

    // 5. Reef fish, in front.
    drawFish(t, 'hover');
  };

  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const cw = Math.round(innerWidth * dpr);
    const ch = Math.round(innerHeight * dpr);
    canvas.width = work.width = cw;
    canvas.height = work.height = ch;
    mask.width = beam.width = Math.max(1, Math.ceil(cw / 8));
    mask.height = beam.height = Math.max(1, Math.ceil(ch / 8));
    s = Math.max(cw / W, ch / H); // like preserveAspectRatio="xMidYMax slice"
    ox = (cw - W * s) / 2;
    oy = ch - H * s;
    if (!layers) return;
    // Render the reef images at this size (async; the previous ones stay until ready).
    const token = ++renderToken;
    const w = Math.round(W * s);
    const h = Math.round(H * s);
    Promise.all([loadSvg(reefSvg(layers, theme, false, w, h), w, h), loadSvg(reefSvg(layers, theme, true, w, h), w, h)])
      .then(([sh, li]) => {
        if (token !== renderToken || stopped) return;
        shadowImg = sh;
        litImg = li;
        reveal();
      })
      .catch(() => reveal());
  };

  // The scene stays hidden until the reef is ready, then fades in as a whole (no pop-in).
  const reveal = () => {
    if (still) draw(performance.now());
    else if (!running) {
      running = true;
      frame = requestAnimationFrame(loop);
    }
    requestAnimationFrame(() => canvas.classList.add('ready'));
  };

  let last = 0;
  const loop = (t: number) => {
    if (stopped) return;
    frame = requestAnimationFrame(loop);
    // ~30 fps is plenty for drifting light. The slack keeps the pace even (every 2nd frame
    // at 60 Hz) instead of sometimes skipping two frames when timings wobble.
    if (t - last < 28) return;
    last = t;
    if (t >= nextRay) {
      rays = rays.filter((ray) => t - ray.born < ray.dur);
      if (rays.length < 7) rays.push(newRay(t));
      nextRay = t + 1200 + Math.random() * 2400;
    }
    draw(t);
  };

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 200);
  };
  const scheme = matchMedia('(prefers-color-scheme: light)');
  const onScheme = () => {
    theme = readTheme();
    if (layers) fish = makeFish(layers, theme);
    layout();
  };

  layout();
  const cancelBuild = whenIdle(() => {
    if (stopped) return;
    layers = LAYERS.map(makeLayer);
    fish = makeFish(layers, theme);
    layout();
  });
  addEventListener('resize', onResize);
  scheme.addEventListener('change', onScheme);

  return () => {
    stopped = true;
    cancelBuild();
    cancelAnimationFrame(frame);
    clearTimeout(resizeTimer);
    removeEventListener('resize', onResize);
    scheme.removeEventListener('change', onScheme);
  };
}

/* ======================================================================================
   Marine snow and bubbles (plain CSS animations)
   ====================================================================================== */

function Snow() {
  const flakes = useMemo(() => {
    const r = rng(7);
    return Array.from({ length: 46 }, (_, i) => ({
      i,
      x: r() * 100,
      size: 1 + r() * 2.2,
      dur: 18 + r() * 30,
      delay: -r() * 48,
      sway: (r() - 0.5) * 60,
      o: 0.25 + r() * 0.5,
    }));
  }, []);
  return (
    <div className="snow">
      {flakes.map((fl) => (
        <span
          key={fl.i}
          style={{ left: `${fl.x}%`, width: fl.size, height: fl.size, opacity: fl.o, animationDuration: `${fl.dur}s`, animationDelay: `${fl.delay}s`, '--sway': `${fl.sway}px` } as CSSProperties}
        />
      ))}
    </div>
  );
}

function Bubbles({ x, seed }: { x: number; seed: number }) {
  const list = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: 9 }, (_, i) => ({ i, size: 3 + r() * 7, dur: 7 + r() * 6, delay: -r() * 13, dx: (r() - 0.5) * 18 }));
  }, [seed]);
  return (
    <div className="bubble-stream" style={{ left: `${x}%` }}>
      {list.map((b) => (
        <span key={b.i} style={{ width: b.size, height: b.size, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s`, '--dx': `${b.dx}px` } as CSSProperties} />
      ))}
    </div>
  );
}

export function Ocean() {
  const onTank = matchRoute(usePath()).name === 'tank';
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (onTank || !canvas.current) return;
    return startScene(canvas.current);
  }, [onTank]);

  // On a Tank the video is the show: leave the GPU to it.
  if (onTank) return null;

  return (
    <div className="ocean" aria-hidden>
      <canvas ref={canvas} />
      <Bubbles x={21} seed={3} />
      <Bubbles x={67} seed={5} />
      <Bubbles x={88} seed={9} />
      <Snow />
    </div>
  );
}
