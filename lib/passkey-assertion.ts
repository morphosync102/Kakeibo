// Server-side only. Verifies a passkey assertion against the stored passkey
// (GAS authGetCredential) and records its use (authRecordCredentialUse: the
// one-time challenge and the counter). Shared by login/verify and
// passkeys/add/reauth (design §3.3, §3.6).
// Logs only fixed texts and GAS error codes (never challenges or secrets).
// Keep free of `@/` imports so node --test can load it directly.

import { callGasAuth, type GasAuthEnv } from './gas-auth.ts';
import { normalizeSessionUser, type SessionUser } from './session.ts';
import { sha256Hex } from './webauthn-challenge.ts';
import { parseStoredCredential, userIdFromUserHandle, verifyAuthentication, type WebAuthnConfig } from './webauthn.ts';
import { failureFromGas, type HttpFailure } from './passkey-flow.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export type AssertionResult =
    | { ok: true; user: SessionUser; displayName: string }
    | { ok: false; failure: HttpFailure };

type Logger = Pick<Console, 'error' | 'warn'>;

const VERIFICATION_FAILED: HttpFailure = Object.freeze({ status: 401, error: 'VerificationFailed' });
const UNAVAILABLE: HttpFailure = Object.freeze({ status: 503, error: 'Service Unavailable' });

// expectedUserId: re-authentication of a signed-in user (the assertion's
// userHandle and the passkey's owner must both be that user).
export async function verifyPasskeyAssertion({ config, env, fetchImpl, response, challenge, expectedUserId, log = console }: {
    config: WebAuthnConfig;
    env: GasAuthEnv;
    fetchImpl: typeof fetch;
    response: AuthenticationResponseJSON;
    challenge: string;
    expectedUserId?: string;
    log?: Logger;
}): Promise<AssertionResult> {
    // Discoverable credentials always return the userHandle (= userId bytes)
    const handleUserId = userIdFromUserHandle(response);
    if (!handleUserId || (expectedUserId !== undefined && handleUserId !== expectedUserId)) return { ok: false, failure: VERIFICATION_FAILED };

    const found = await callGasAuth('authGetCredential', { credentialId: response.id }, { env, fetchImpl });
    if (!found.ok) {
        // A missing / revoked passkey looks like any other failed verification
        if (found.error === 'CredentialNotFound') return { ok: false, failure: VERIFICATION_FAILED };
        log.error(`Passkey assertion: authGetCredential failed (${found.error}${found.detail ? `: ${found.detail}` : ''})`);
        return { ok: false, failure: UNAVAILABLE };
    }
    const stored = parseStoredCredential(found.data.credential);
    const user = normalizeSessionUser(found.data.user);
    if (!stored || !user) {
        log.error('Passkey assertion: authGetCredential returned an invalid credential or user.');
        return { ok: false, failure: UNAVAILABLE };
    }
    // The passkey must belong to the user its userHandle names
    if (stored.credentialId !== response.id || stored.userId !== user.userId || stored.userId !== handleUserId) {
        log.warn('Passkey assertion: userHandle does not match the passkey owner.');
        return { ok: false, failure: VERIFICATION_FAILED };
    }

    const verified = await verifyAuthentication(config, response, challenge, stored);
    if (!verified) return { ok: false, failure: VERIFICATION_FAILED };

    const recorded = await callGasAuth('authRecordCredentialUse', {
        credentialId: stored.credentialId,
        counter: verified.newCounter,
        challengeHash: await sha256Hex(challenge),
    }, { env, fetchImpl });
    if (!recorded.ok) {
        // A reused challenge or a passkey revoked meanwhile fails; anything
        // else (Busy, transport) only loses lastUsedAt / the counter (§3.6)
        if (recorded.error === 'ChallengeReused' || recorded.error === 'CredentialNotFound') {
            return { ok: false, failure: failureFromGas(recorded.error) };
        }
        log.warn(`Passkey assertion: authRecordCredentialUse failed (${recorded.error}); continuing.`);
    }
    const rawUser = found.data.user as Record<string, unknown>;
    return { ok: true, user, displayName: typeof rawUser.displayName === 'string' ? rawUser.displayName : '' };
}
