// A password session (amr=pwd) of the removed migration-period login, signed
// exactly as the old createSession did (v2 format, HMAC-SHA256 with the raw
// SESSION_SECRET). createSession can no longer issue one; tests use this to
// check such cookies are always refused. Synthetic data only. Not a test file.
import { createHmac, randomBytes } from 'node:crypto';
import { SESSION_TTL_SECONDS } from '../../lib/session.ts';

export function legacyPasswordSession(secret, { userId, epoch, sources, homeSource }, now = Date.now()) {
    const issued = Math.floor(now / 1000);
    const ordered = [homeSource, ...sources.filter(s => s !== homeSource)];
    const payload = ['v2', issued, issued + SESSION_TTL_SECONDS, randomBytes(16).toString('hex'), userId, epoch, ordered.join('+'), 'pwd'].join('.');
    return `${payload}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest('hex')}`;
}
