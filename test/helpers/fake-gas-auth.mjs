// In-memory stand-in for the GAS auth actions used by the passkey routes,
// following the SPECIFICATION "認証API" contract (and gas/コード.js): invite
// one-time use, one-time challengeHash, counter updated only when it grows,
// actor epoch check, bootstrap only for an admin without passkeys.
// Synthetic data only. Not a test file itself.
import { createHash } from 'node:crypto';

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function createFakeGas({ authKey, users, invites = {}, credentials = [] }) {
    const state = {
        users: new Map(users.map(u => [u.userId, { status: 'active', ...u }])),
        invites: new Map(Object.entries(invites).map(([token, v]) => [sha256(token), { used: false, expired: false, ...v }])),
        credentials: new Map(credentials.map(c => [c.credentialId, { revoked: false, transports: [], ...c }])),
        challenges: new Set(),
        bodies: [],
        override: {}, // action -> response (one-shot failure injection)
    };
    const toUser = u => ({ userId: u.userId, displayName: u.displayName, sources: u.sources, homeSource: u.homeSource, epoch: u.epoch });
    const active = userId => [...state.credentials.values()].filter(c => c.userId === userId && !c.revoked);
    const actor = body => {
        const u = state.users.get(body.actorUserId);
        if (!u || u.status !== 'active' || u.epoch !== body.actorEpoch) return null;
        return u;
    };
    const handlers = {
        authPeekInvite: b => {
            const inv = state.invites.get(b.tokenHash);
            if (!inv || inv.used || inv.expired) return { error: 'InviteInvalid' };
            const u = state.users.get(inv.userId);
            return {
                success: true, purpose: 'register', user: { userId: u.userId, displayName: u.displayName },
                credentials: active(u.userId).map(c => ({ credentialId: c.credentialId, transports: c.transports })),
            };
        },
        authConsumeInviteAndAddCredential: b => {
            const inv = state.invites.get(b.tokenHash);
            if (!inv || inv.used || inv.expired) return { error: 'InviteInvalid' };
            if (state.credentials.has(b.credential.credentialId)) return { error: 'CredentialExists' };
            if (state.challenges.has(b.challengeHash)) return { error: 'ChallengeReused' };
            state.challenges.add(b.challengeHash);
            inv.used = true;
            state.credentials.set(b.credential.credentialId, { ...b.credential, userId: inv.userId, revoked: false });
            return { success: true, user: toUser(state.users.get(inv.userId)) };
        },
        authAddCredential: b => {
            const u = actor(b);
            if (!u) return { error: 'SessionRevoked' };
            const count = active(u.userId).length;
            if (b.bootstrap === true) {
                if (u.role !== 'admin' || count > 0) return { error: 'BootstrapNotAllowed' };
            } else if (count === 0) return { error: 'NoExistingCredential' };
            if (state.credentials.has(b.credential.credentialId)) return { error: 'CredentialExists' };
            if (state.challenges.has(b.challengeHash)) return { error: 'ChallengeReused' };
            state.challenges.add(b.challengeHash);
            state.credentials.set(b.credential.credentialId, { ...b.credential, userId: u.userId, revoked: false });
            return { success: true, credentialCount: count + 1 };
        },
        authGetCredential: b => {
            const c = state.credentials.get(b.credentialId);
            const u = c && state.users.get(c.userId);
            if (!c || c.revoked || !u || u.status !== 'active') return { error: 'CredentialNotFound' };
            return {
                success: true,
                credential: { credentialId: c.credentialId, userId: c.userId, publicKey: c.publicKey, counter: c.counter, transports: c.transports },
                user: toUser(u),
            };
        },
        authRecordCredentialUse: b => {
            const c = state.credentials.get(b.credentialId);
            if (!c || c.revoked) return { error: 'CredentialNotFound' };
            if (state.challenges.has(b.challengeHash)) return { error: 'ChallengeReused' };
            state.challenges.add(b.challengeHash);
            c.lastUsed = true;
            if (b.counter > c.counter) c.counter = b.counter;
            return { success: true };
        },
        authListCredentials: b => {
            const u = actor(b);
            if (!u) return { error: 'SessionRevoked' };
            return { success: true, credentials: active(u.userId).map(c => ({ credentialId: c.credentialId, label: c.label ?? 'パスキー' })) };
        },
    };
    const upstream = ([, init]) => {
        const body = JSON.parse(init.body);
        state.bodies.push(body);
        if (body.authKey !== authKey) return { error: 'Unauthorized' };
        if (state.override[body.action]) {
            const answer = state.override[body.action];
            delete state.override[body.action];
            if (answer instanceof Error) throw answer;
            return answer;
        }
        const handler = handlers[body.action];
        return handler ? handler(body) : { error: 'Unknown action' };
    };
    return { state, upstream };
}
