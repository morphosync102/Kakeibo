// Server-side only. Small pure helpers shared by the passkey route handlers
// (/api/auth/register/*, /api/auth/login/*, /api/auth/passkeys/add/*).
// Responses carry only fixed error words: never GAS details, library
// messages, challenges, tokens or secrets.
// Keep free of `@/` and runtime imports so node --test can load it directly.

export const NO_STORE = Object.freeze({ 'Cache-Control': 'no-store' });

// Invite tokens are 256-bit base64url (43 characters) from GAS; accept a
// little slack, nothing else (the fragment is never logged).
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function inviteTokenFrom(value: unknown): string | null {
    return typeof value === 'string' && INVITE_TOKEN_PATTERN.test(value) ? value : null;
}

// The JSON object body of a request, or null (not JSON / not an object / too large)
export async function readJsonObject(request: Request, maxLength = 65536): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
        text = await request.text();
    } catch {
        return null;
    }
    if (text.length > maxLength) return null;
    try {
        const body = JSON.parse(text) as unknown;
        return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export interface HttpFailure {
    status: number;
    error: string;
    revokeSession?: boolean; // also delete the session cookie
}

// GAS auth error (or callGasAuth's NotConfigured / BadGateway / Unavailable)
// -> the HTTP failure of a passkey route
export function failureFromGas(error: string): HttpFailure {
    switch (error) {
        case 'InviteInvalid': return { status: 410, error: 'InviteInvalid' };
        case 'CredentialExists': return { status: 409, error: 'CredentialExists' };
        case 'ChallengeReused': return { status: 400, error: 'ChallengeInvalid' };
        case 'CredentialNotFound': return { status: 401, error: 'VerificationFailed' };
        case 'SessionRevoked': return { status: 401, error: 'Unauthorized', revokeSession: true };
        case 'NoExistingCredential':
        case 'BootstrapNotAllowed': return { status: 403, error: 'NotAllowed' };
        default: return { status: 503, error: 'Service Unavailable' };
    }
}
