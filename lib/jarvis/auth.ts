import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const COOKIE = 'jarvis_access';
export const MAX_AGE = 60 * 60 * 24 * 7;
export function passwordConfigured() {
  return (process.env.JARVIS_ACCESS_PASSWORD?.length ?? 0) >= 16;
}
export function matchesPassword(value: string) {
  const expected = process.env.JARVIS_ACCESS_PASSWORD ?? '';
  const hash = (s: string) => createHmac('sha256', 'jarvis-password-comparison').update(s).digest();
  return passwordConfigured() && timingSafeEqual(hash(value), hash(expected));
}
function signature(payload: string) {
  return createHmac('sha256', process.env.JARVIS_ACCESS_PASSWORD ?? '').update(payload).digest('base64url');
}
export function issueToken(now = Date.now()) {
  const payload = `${Math.floor(now / 1000) + MAX_AGE}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${signature(payload)}`;
}
export function validToken(token: string, now = Date.now()) {
  if (!passwordConfigured()) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false;
  const expires = Number(parts[0]);
  if (expires <= now / 1000 || expires > now / 1000 + MAX_AGE + 1) return false;
  const expected = Buffer.from(signature(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
