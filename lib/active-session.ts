// Server-side only (middleware and the login / invite Route Handlers): the
// app lock's sliding "active" cookie (design 2026-11-yuki-and-passkeys
// §3.12, timings in lib/app-lock.ts).
//
// Token: a1.<expires>.<userId>.<epoch>.<sig>
// - expires: unix seconds, now + ACTIVE_TTL_MS at each refresh
// - userId / epoch: those of the session it was issued with; any other
//   session (another user, or the same user after epoch +1) does not accept it
// - sig: HMAC-SHA256 hex with a key derived from SESSION_SECRET for this use
//   only (HMAC(SESSION_SECRET, ACTIVE_KEY_LABEL)), so it is neither a session
//   token nor a WebAuthn challenge token.
// Keep free of `@/` imports so node --test can load it directly.

import { ACTIVE_TTL_MS } from './app-lock.ts';
import { isSessionSecretConfigured } from './session.ts';

export const ACTIVE_COOKIE = 'kakeibo_active';
export const ACTIVE_TTL_SECONDS = Math.floor(ACTIVE_TTL_MS / 1000);
const ACTIVE_KEY_LABEL = 'kakeibo/app-lock-active/v1';
const MAX_TOKEN_LENGTH = 192;
const CLOCK_SKEW_SECONDS = 60;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EPOCH = 1000000000;
const TOKEN_PATTERN = /^(a1\.([1-9]\d{0,14})\.([A-Za-z0-9_-]{1,64})\.(0|[1-9]\d{0,9}))\.([a-f0-9]{64})$/;

export interface ActiveSubject {
    userId: string;
    epoch: number;
}

function fromHex(value: string) {
    return Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
}

function toHex(value: Uint8Array) {
    return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function activeKey(secret: string) {
    if (!isSessionSecretConfigured(secret)) throw new Error('Session signing key is not configured');
    const master = await crypto.subtle.importKey('raw', fromHex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const derived = await crypto.subtle.sign('HMAC', master, new TextEncoder().encode(ACTIVE_KEY_LABEL));
    return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function isSubject(subject: ActiveSubject): boolean {
    return USER_ID_PATTERN.test(subject.userId) && Number.isInteger(subject.epoch) && subject.epoch >= 0 && subject.epoch <= MAX_EPOCH;
}

export async function createActiveToken(secret: string, subject: ActiveSubject, now = Date.now()): Promise<string> {
    if (!isSubject(subject)) throw new Error('Invalid active subject');
    const payload = ['a1', Math.floor(now / 1000) + ACTIVE_TTL_SECONDS, subject.userId, subject.epoch].join('.');
    const signature = await crypto.subtle.sign('HMAC', await activeKey(secret), new TextEncoder().encode(payload));
    return `${payload}.${toHex(new Uint8Array(signature))}`;
}

// True only for an unexpired, untampered token of this exact session subject
// (same userId and epoch), signed with the active key of this SESSION_SECRET.
export async function isActiveTokenValid(token: unknown, secret: string | undefined, subject: ActiveSubject, now = Date.now()): Promise<boolean> {
    if (!isSessionSecretConfigured(secret) || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return false;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return false;
    const [, payload, expiresText, userId, epochText, signature] = match;
    const expires = Number(expiresText);
    const current = Math.floor(now / 1000);
    // expired, or further ahead than a fresh token can be
    if (!Number.isSafeInteger(expires) || expires <= current || expires > current + ACTIVE_TTL_SECONDS + CLOCK_SKEW_SECONDS) return false;
    if (userId !== subject.userId || Number(epochText) !== subject.epoch) return false;
    try {
        return await crypto.subtle.verify('HMAC', await activeKey(secret), fromHex(signature), new TextEncoder().encode(payload));
    } catch {
        return false;
    }
}

// HttpOnly, SameSite=Strict, Path=/, Secure in production; the browser drops
// it when the sliding window ends
export function activeCookieOptions(env: { NODE_ENV?: string }, maxAge = ACTIVE_TTL_SECONDS) {
    return {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict' as const,
        maxAge,
        path: '/',
    };
}
