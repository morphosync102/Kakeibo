// Server-side only: never import this module from a client component.
export const SESSION_COOKIE = 'kakeibo_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

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

export async function createSession(secret: string, now = Date.now()): Promise<string> {
    const key = await signingKey(secret);
    const issued = Math.floor(now / 1000);
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const payload = `v1.${issued}.${issued + SESSION_TTL_SECONDS}.${nonce}`;
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return `${payload}.${toHex(new Uint8Array(signature))}`;
}

export async function verifySession(token: unknown, secret: string | undefined, now = Date.now()): Promise<boolean> {
    if (!isSessionSecretConfigured(secret) || typeof token !== 'string' || token.length > 256) return false;
    const match = /^(v1\.([1-9]\d{0,14})\.([1-9]\d{0,14})\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
    if (!match) return false;
    const [, payload, issuedText, expiresText, signature] = match;
    const issued = Number(issuedText);
    const expires = Number(expiresText);
    const current = Math.floor(now / 1000);
    if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires)
        || expires - issued !== SESSION_TTL_SECONDS || issued > current + 60 || expires <= current) return false;
    try {
        return await crypto.subtle.verify('HMAC', await signingKey(secret), fromHex(signature), new TextEncoder().encode(payload));
    } catch {
        return false;
    }
}
