import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// Crockford base32: no I, L, O, U, so codes are easy to read aloud and type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** e.g. randomCode('FISH', 3) -> "FISH-7KQ2-M9XD-3TQA" (5 bits per char, 20 chars = 60 bits). */
export function randomCode(prefix: string, groups = 3, groupLen = 4): string {
  const bytes = randomBytes(groups * groupLen);
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]); // 256 % 32 === 0, so no modulo bias
  const parts: string[] = [];
  for (let i = 0; i < groups; i++) parts.push(chars.slice(i * groupLen, (i + 1) * groupLen).join(''));
  return `${prefix}-${parts.join('-')}`;
}

/** Canonical form for hashing: case/dash/space-insensitive, and forgiving of O/0 and I/L/1 mix-ups. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const GUEST_ADJECTIVES = ['Sleepy', 'Bubbly', 'Sneaky', 'Shiny', 'Wobbly', 'Grumpy', 'Zippy', 'Curious', 'Fancy', 'Speedy', 'Cozy', 'Brave', 'Giggly', 'Mellow', 'Dizzy', 'Lucky'];
const GUEST_FISH = ['Pufferfish', 'Guppy', 'Clownfish', 'Seahorse', 'Angelfish', 'Goldfish', 'Minnow', 'Catfish', 'Tetra', 'Betta', 'Koi', 'Stingray', 'Octopus', 'Shrimp', 'Starfish', 'Jellyfish'];

/** A display name like "Sleepy Pufferfish 42" and a matching unique-ish username for a guest. */
export function guestIdentity(): { displayName: string; username: string } {
  const b = randomBytes(6);
  const displayName = `${GUEST_ADJECTIVES[b[0]! & 15]} ${GUEST_FISH[b[1]! & 15]} ${10 + (b[2]! % 90)}`;
  const suffix = Array.from(b.subarray(3), (x) => ALPHABET[x & 31]).join('').toLowerCase();
  return { displayName, username: `guest-${suffix}${(b[2]! % 90) + 10}` };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPassword(password: string): Promise<string> {
  return hash(password); // argon2id with library defaults (19 MiB, t=2)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verified against when the username doesn't exist, so response timing doesn't reveal valid usernames.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash(newToken());
  await verifyPassword(await dummyHash, password);
}
