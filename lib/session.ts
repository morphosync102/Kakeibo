// Server-side only (Route Handlers and middleware): never import this module
// from a client component. Session v2 (design 2026-11-yuki-and-passkeys §3.8).
//
// Token: v2.<issued>.<expires>.<nonce>.<userId>.<epoch>.<sources>.<amr>.<sig>
// - sources: '+'-joined source ids, the home source first
// - amr: always 'pk' (passkey). 'pwd' was the shared-password login of the
//   migration period (removed in U6): such tokens are always rejected.
// - sig: HMAC-SHA256(SESSION_SECRET) over everything before it
// v1 tokens (no user) are rejected: everyone logs in again once.
// Keep free of `@/` and runtime imports so node --test can load it directly.

export const SESSION_COOKIE = 'kakeibo_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_TOKEN_LENGTH = 512;

// The registry ids (lib/sources.ts SOURCE_IDS; literal because this module
// loads without imports, test/session.test.mjs checks they match).
export const SESSION_SOURCE_IDS: readonly string[] = Object.freeze(['main', 'yahoo', 'yuki']);

// Same as the GAS actor contract (ACTOR_USER_ID_PATTERN / MAX_ACTOR_EPOCH)
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EPOCH = 1000000000;

// Only passkey sessions exist; the password login was removed (U6)
export type Amr = 'pk';

export interface SessionUser {
    userId: string;
    epoch: number;
    sources: readonly string[];
    homeSource: string;
}

export interface Session {
    userId: string;
    epoch: number;
    sources: string[]; // the home source first
    homeSource: string;
    amr: Amr;
}

// The environment readSession depends on (pass process.env)
export interface SessionEnv {
    SESSION_SECRET?: string;
    [name: string]: string | undefined;
}

export function isSessionSecretConfigured(secret: string | undefined): secret is string {
    return typeof secret === 'string' && /^[a-f0-9]{64}$/i.test(secret);
}

function fromHex(value: string) {
    return Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));
}

function toHex(value: Uint8Array) {
    return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signingKey(secret: string) {
    if (!isSessionSecretConfigured(secret)) throw new Error('Session signing key is not configured');
    return crypto.subtle.importKey('raw', fromHex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function isEpoch(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_EPOCH;
}

// Validated user with the home source first, or null. Also used for the user
// GAS returns (invite registration, passkey login) before a session is issued from it.
export function normalizeSessionUser(user: unknown): SessionUser | null {
    if (!user || typeof user !== 'object') return null;
    const { userId, epoch, sources, homeSource } = user as Record<string, unknown>;
    if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId) || !isEpoch(epoch)) return null;
    if (!Array.isArray(sources) || sources.length === 0) return null;
    if (!sources.every(s => typeof s === 'string' && SESSION_SOURCE_IDS.includes(s))) return null;
    if (new Set(sources).size !== sources.length) return null;
    if (typeof homeSource !== 'string' || !sources.includes(homeSource)) return null;
    return { userId, epoch, sources: [homeSource, ...sources.filter(s => s !== homeSource)], homeSource };
}

export async function createSession(secret: string, user: SessionUser & { amr: Amr }, now = Date.now()): Promise<string> {
    const key = await signingKey(secret);
    const normalized = normalizeSessionUser(user);
    if (!normalized) throw new Error('Invalid session user');
    if (user.amr !== 'pk') throw new Error('Invalid session amr');
    const issued = Math.floor(now / 1000);
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const payload = ['v2', issued, issued + SESSION_TTL_SECONDS, nonce, normalized.userId, normalized.epoch, normalized.sources.join('+'), user.amr].join('.');
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const token = `${payload}.${toHex(new Uint8Array(signature))}`;
    if (token.length > MAX_TOKEN_LENGTH) throw new Error('Session token too long');
    return token;
}

const TOKEN_PATTERN = /^(v2\.([1-9]\d{0,14})\.([1-9]\d{0,14})\.[a-f0-9]{32}\.([A-Za-z0-9_-]{1,64})\.(0|[1-9]\d{0,9})\.([a-z]+(?:\+[a-z]+)*)\.(pwd|pk))\.([a-f0-9]{64})$/;

// The signed-in user, or null for anything invalid: malformed, tampered,
// expired, issued in the future, v1, signed with another key, or a password
// session of the migration period (amr=pwd: always, whatever the environment;
// the middleware then sends the screen to /login?reason=session).
export async function readSession(token: unknown, env: SessionEnv, now = Date.now()): Promise<Session | null> {
    const secret = env.SESSION_SECRET;
    if (!isSessionSecretConfigured(secret) || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const [, payload, issuedText, expiresText, userId, epochText, sourcesText, amr, signature] = match;
    const issued = Number(issuedText);
    const expires = Number(expiresText);
    const current = Math.floor(now / 1000);
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires)
        || expires - issued !== SESSION_TTL_SECONDS || issued > current + 60 || expires <= current) return null;
    let valid = false;
    try {
        valid = await crypto.subtle.verify('HMAC', await signingKey(secret), fromHex(signature), new TextEncoder().encode(payload));
    } catch {
        return null;
    }
    if (!valid) return null;
    if (amr !== 'pk') return null; // amr=pwd: the password login is gone
    const sources = sourcesText.split('+');
    const user = normalizeSessionUser({ userId, epoch: Number(epochText), sources, homeSource: sources[0] });
    if (!user) return null;
    return { userId: user.userId, epoch: user.epoch, sources: [...user.sources], homeSource: user.homeSource, amr: 'pk' };
}

// Cookie attributes (HttpOnly, SameSite=Strict, Path=/, Secure in production)
export function sessionCookieOptions(env: { NODE_ENV?: string }, maxAge = SESSION_TTL_SECONDS) {
    return {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict' as const,
        maxAge,
        path: '/',
    };
}

// Compares SHA-256 digests of both values over all 32 bytes, so the time does
// not depend on where (or whether) the inputs differ, nor on their lengths.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [digestA, digestB] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(a)),
        crypto.subtle.digest('SHA-256', encoder.encode(b)),
    ]);
    const x = new Uint8Array(digestA);
    const y = new Uint8Array(digestB);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}
