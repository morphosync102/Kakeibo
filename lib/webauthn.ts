// Server-side only (Node.js route handlers; never middleware / Edge, never a
// client component). Passkey options and verification with
// @simplewebauthn/server (design 2026-11-yuki-and-passkeys §3.1-3.6).
//
// - rpID and the expected origin come only from WEBAUTHN_RP_ID /
//   WEBAUTHN_ORIGIN, never from the Host header. Unset or invalid: passkeys
//   are disabled (routes answer 503), e.g. on a preview deployment.
// - Discoverable credentials (residentKey required), user verification
//   required, attestation 'none', ES256 / RS256.
// - The WebAuthn user.id (userHandle) is the UTF-8 bytes of the userId.
// - Verification errors are swallowed (null): library messages contain
//   challenges and origins and must not reach responses or logs.
// Keep free of `@/` imports so node --test can load it directly.

import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from '@simplewebauthn/server';

export const RP_NAME = 'Kakeibo';
export const SUPPORTED_ALGORITHM_IDS: readonly number[] = Object.freeze([-7, -257]); // ES256, RS256
export const CEREMONY_TIMEOUT_MS = 120_000; // shorter than the 5-minute challenge cookie
const MAX_CREDENTIAL_ID_LENGTH = 1364; // same as GAS (1023 bytes in base64url)
const MAX_RESPONSE_FIELD_LENGTH = 16384;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS: readonly string[] = Object.freeze(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card']);
const DEFAULT_USER_NAME = '家計簿';

export interface WebAuthnEnv {
    WEBAUTHN_RP_ID?: string;
    WEBAUTHN_ORIGIN?: string;
    [name: string]: string | undefined;
}

export interface WebAuthnConfig {
    rpID: string;
    origin: string;
}

// rpID: a lowercase host name. origin: exactly scheme://host[:port] (no path),
// https (http only for localhost), on rpID or a subdomain of it.
export function webauthnConfig(env: WebAuthnEnv): WebAuthnConfig | null {
    const rpID = env.WEBAUTHN_RP_ID;
    const origin = env.WEBAUTHN_ORIGIN;
    if (typeof rpID !== 'string' || typeof origin !== 'string') return null;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(rpID) || rpID.length > 253) return null;
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) return null;
    if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) return null;
    return { rpID, origin };
}

export function isBase64Url(value: unknown, maxLength = MAX_CREDENTIAL_ID_LENGTH): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength && BASE64URL_PATTERN.test(value);
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(value, 'base64url'));
}

function bytesToBase64Url(value: Uint8Array): string {
    return Buffer.from(value).toString('base64url');
}

export interface StoredCredentialRef {
    credentialId: string;
    transports?: readonly string[];
}

function toDescriptors(credentials: readonly StoredCredentialRef[]) {
    return credentials
        .filter(c => isBase64Url(c.credentialId))
        .map(c => ({
            id: c.credentialId,
            transports: (c.transports ?? []).filter(t => TRANSPORTS.includes(t)),
        }));
}

export async function registrationOptions(
    config: WebAuthnConfig,
    { userId, userName, challenge, exclude }: { userId: string; userName?: string; challenge: string; exclude: readonly StoredCredentialRef[] },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid userId');
    const name = typeof userName === 'string' && userName.trim() !== '' ? userName.trim().slice(0, 64) : DEFAULT_USER_NAME;
    return generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: config.rpID,
        userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
        userName: name,
        userDisplayName: name,
        // bytes, so options.challenge is exactly our base64url challenge (a
        // string would be taken as UTF-8 text and encoded again)
        challenge: base64UrlToBytes(challenge),
        timeout: CEREMONY_TIMEOUT_MS,
        attestationType: 'none',
        excludeCredentials: toDescriptors(exclude),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
    });
}

export async function authenticationOptions(
    config: WebAuthnConfig,
    { challenge, allow = [] }: { challenge: string; allow?: readonly StoredCredentialRef[] },
): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
        rpID: config.rpID,
        challenge: base64UrlToBytes(challenge),
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification: 'required',
        allowCredentials: toDescriptors(allow),
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasStringFields(record: Record<string, unknown>, names: readonly string[]): boolean {
    return names.every(name => typeof record[name] === 'string' && (record[name] as string).length <= MAX_RESPONSE_FIELD_LENGTH);
}

// Shape checks before anything is sent to GAS (the library checks the rest)
export function parseRegistrationResponse(value: unknown): RegistrationResponseJSON | null {
    if (!isRecord(value) || !isBase64Url(value.id) || value.rawId !== value.id || value.type !== 'public-key') return null;
    if (!isRecord(value.response) || !hasStringFields(value.response, ['clientDataJSON', 'attestationObject'])) return null;
    return value as unknown as RegistrationResponseJSON;
}

export function parseAuthenticationResponse(value: unknown): AuthenticationResponseJSON | null {
    if (!isRecord(value) || !isBase64Url(value.id) || value.rawId !== value.id || value.type !== 'public-key') return null;
    if (!isRecord(value.response) || !hasStringFields(value.response, ['clientDataJSON', 'authenticatorData', 'signature'])) return null;
    const { userHandle } = value.response;
    if (userHandle !== undefined && (typeof userHandle !== 'string' || userHandle.length > MAX_RESPONSE_FIELD_LENGTH)) return null;
    return value as unknown as AuthenticationResponseJSON;
}

// The userId in an assertion's userHandle, or null (missing / not a userId)
export function userIdFromUserHandle(response: AuthenticationResponseJSON): string | null {
    const handle = response.response.userHandle;
    if (!isBase64Url(handle, 128)) return null;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(handle));
    } catch {
        return null;
    }
    return USER_ID_PATTERN.test(text) ? text : null;
}

// The verified passkey in the GAS `credential` shape (SPECIFICATION 認証API)
export interface VerifiedCredential {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    deviceType: 'singleDevice' | 'multiDevice';
    backedUp: boolean;
    label: string;
}

export async function verifyRegistration(
    config: WebAuthnConfig,
    response: RegistrationResponseJSON,
    expectedChallenge: string,
    label: string,
): Promise<VerifiedCredential | null> {
    try {
        const result = await verifyRegistrationResponse({
            response,
            expectedChallenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpID,
            requireUserVerification: true,
            supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
        });
        if (!result.verified || !result.registrationInfo.userVerified) return null;
        const info = result.registrationInfo;
        const transports = (response.response.transports ?? []).filter((t, i, all) => TRANSPORTS.includes(t) && all.indexOf(t) === i);
        return {
            credentialId: info.credential.id,
            publicKey: bytesToBase64Url(info.credential.publicKey),
            counter: info.credential.counter,
            transports,
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            label,
        };
    } catch {
        return null;
    }
}

// The stored passkey as GAS authGetCredential returns it
export interface StoredCredential {
    credentialId: string;
    userId: string;
    publicKey: string;
    counter: number;
    transports: string[];
}

export function parseStoredCredential(value: unknown): StoredCredential | null {
    if (!isRecord(value)) return null;
    const { credentialId, userId, publicKey, counter, transports } = value;
    if (!isBase64Url(credentialId) || typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) return null;
    if (!isBase64Url(publicKey, 4096)) return null;
    if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0 || counter > 4294967295) return null;
    const list = Array.isArray(transports) ? transports.filter((t): t is string => typeof t === 'string' && TRANSPORTS.includes(t)) : [];
    return { credentialId, userId, publicKey, counter, transports: list };
}

// The new signature counter of a verified assertion, or null. Rejects user
// verification missing, wrong origin / rpID / challenge, a bad signature and
// a counter that did not increase (when either side is non-zero).
export async function verifyAuthentication(
    config: WebAuthnConfig,
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    stored: StoredCredential,
): Promise<{ newCounter: number } | null> {
    if (response.id !== stored.credentialId) return null;
    try {
        const result = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpID,
            requireUserVerification: true,
            credential: {
                id: stored.credentialId,
                publicKey: base64UrlToBytes(stored.publicKey),
                counter: stored.counter,
                transports: stored.transports,
            },
        });
        if (!result.verified || !result.authenticationInfo.userVerified) return null;
        return { newCounter: result.authenticationInfo.newCounter };
    } catch {
        return null;
    }
}

// A label for the new passkey from the browser's User-Agent (display only)
export function labelFromUserAgent(userAgent: string | null): string {
    const ua = userAgent ?? '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    return 'パスキー';
}
