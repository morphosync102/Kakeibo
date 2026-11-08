// Server-side only. Short-lived signed WebAuthn challenge cookie
// (design 2026-11-yuki-and-passkeys §3.4): stateless, 5 minutes, bound to one
// purpose and one subject, deleted by every verify (success or failure).
//
// Token: wa1.<purpose>.<issued>.<expires>.<challenge>.<binding>.<sig>
// - purpose: register | login | reauth | add ('bootstrap', the password
//   re-entry of the migration period, was removed in U6 and is rejected)
// - challenge: 32 random bytes, base64url (what the authenticator signs)
// - binding: register -> invite token hash (64 hex), login -> '-',
//   reauth / add -> the session userId
// - sig: HMAC-SHA256 hex with a key derived from SESSION_SECRET for this use
//   only (HMAC(SESSION_SECRET, CHALLENGE_KEY_LABEL)), so a challenge token is
//   never a session token and vice versa (different key and format).
// One-time use: GAS records the SHA-256 of each verified challenge for 5
// minutes (challengeHash, ChallengeReused).
// Keep free of `@/` and runtime imports so node --test can load it directly.

import { isSessionSecretConfigured } from './session.ts';

export const CHALLENGE_COOKIE = 'kakeibo_webauthn';
export const CHALLENGE_TTL_SECONDS = 300;
export const CHALLENGE_COOKIE_PATH = '/api/auth';
const CHALLENGE_KEY_LABEL = 'kakeibo/webauthn-challenge/v1';
const MAX_TOKEN_LENGTH = 256;

export type ChallengePurpose = 'register' | 'login' | 'reauth' | 'add';
export const LOGIN_BINDING = '-';

export interface ChallengeClaims {
    purpose: ChallengePurpose;
    challenge: string;
    binding: string;
}

const PURPOSES: readonly ChallengePurpose[] = Object.freeze(['register', 'login', 'reauth', 'add']);
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^(wa1\.(register|login|reauth|add)\.([1-9]\d{0,14})\.([1-9]\d{0,14})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{1,64}))\.([a-f0-9]{64})$/;

function isValidBinding(purpose: ChallengePurpose, binding: string): boolean {
    if (purpose === 'register') return HASH_PATTERN.test(binding);
    if (purpose === 'login') return binding === LOGIN_BINDING;
    return USER_ID_PATTERN.test(binding);
}

function fromHex(value: string) {
    return Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
}

function toHex(value: Uint8Array) {
    return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeKey(secret: string) {
    if (!isSessionSecretConfigured(secret)) throw new Error('Session signing key is not configured');
    const master = await crypto.subtle.importKey('raw', fromHex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const derived = await crypto.subtle.sign('HMAC', master, new TextEncoder().encode(CHALLENGE_KEY_LABEL));
    return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// 32 random bytes as base64url (43 characters)
export function newChallenge(): string {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

// SHA-256 (lowercase hex) of a UTF-8 string: the challenge hash sent to GAS
// for one-time use, and the invite token hash (same as GAS sha256Hex).
export async function sha256Hex(text: string): Promise<string> {
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export async function createChallengeToken(secret: string, claims: ChallengeClaims, now = Date.now()): Promise<string> {
    if (!PURPOSES.includes(claims.purpose)) throw new Error('Invalid challenge purpose');
    if (!CHALLENGE_PATTERN.test(claims.challenge)) throw new Error('Invalid challenge');
    if (!isValidBinding(claims.purpose, claims.binding)) throw new Error('Invalid challenge binding');
    const issued = Math.floor(now / 1000);
    const payload = ['wa1', claims.purpose, issued, issued + CHALLENGE_TTL_SECONDS, claims.challenge, claims.binding].join('.');
    const signature = await crypto.subtle.sign('HMAC', await challengeKey(secret), new TextEncoder().encode(payload));
    return `${payload}.${toHex(new Uint8Array(signature))}`;
}

// The claims of a valid token whose purpose is one of `purposes` and whose
// binding equals `binding`, or null: malformed, tampered, other key, expired,
// issued in the future, other purpose or other subject.
export async function readChallengeToken(
    token: unknown,
    secret: string | undefined,
    expected: { purposes: readonly ChallengePurpose[]; binding: string },
    now = Date.now(),
): Promise<ChallengeClaims | null> {
    if (!isSessionSecretConfigured(secret) || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const [, payload, purposeText, issuedText, expiresText, challenge, binding, signature] = match;
    const purpose = purposeText as ChallengePurpose;
    const issued = Number(issuedText);
    const expires = Number(expiresText);
    const current = Math.floor(now / 1000);
    if (expires - issued !== CHALLENGE_TTL_SECONDS || issued > current + 60 || expires <= current) return null;
    let valid = false;
    try {
        valid = await crypto.subtle.verify('HMAC', await challengeKey(secret), fromHex(signature), new TextEncoder().encode(payload));
    } catch {
        return null;
    }
    if (!valid) return null;
    if (!expected.purposes.includes(purpose) || binding !== expected.binding || !isValidBinding(purpose, binding)) return null;
    return { purpose, challenge, binding };
}

// HttpOnly, SameSite=Strict, only sent to /api/auth/*, Secure in production
export function challengeCookieOptions(env: { NODE_ENV?: string }, maxAge = CHALLENGE_TTL_SECONDS) {
    return {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict' as const,
        maxAge,
        path: CHALLENGE_COOKIE_PATH,
    };
}
