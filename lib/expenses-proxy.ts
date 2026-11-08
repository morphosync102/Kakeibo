// Pure helpers for the /api/expenses proxy (app/api/expenses/route.ts).
// Keep free of `@/` and Next imports so node --test can load it directly.

// The registry ids (lib/sources.ts SOURCE_IDS; kept as a literal list because
// this file must load without imports, test/sources-theme.test.mjs checks they
// match). Access to a source is decided by the session and GAS, not here.
const ALLOWED_SOURCES: readonly string[] = ['main', 'yahoo', 'yuki'];

// An omitted source (missing query param / body field) means 'main' for old
// clients; current clients always send it. Anything else, including '' and
// case variants such as 'Yahoo', is rejected so a bug can never route one
// kakeibo's data into another's sheets.
export function isAllowedSource(source: unknown): boolean {
    return source === undefined || source === null || (typeof source === 'string' && ALLOWED_SOURCES.includes(source));
}

// The source a request reads or writes (validated by isAllowedSource first):
// an omitted one is main, as GAS treats it.
export function effectiveSource(source: unknown): string {
    return typeof source === 'string' ? source : 'main';
}

// The only actions the proxy forwards in a POST: exactly WRITE_ACTIONS of
// gas/コード.js (test/expenses-proxy.test.mjs compares them). Auth actions are
// never reachable through /api/expenses; /api/auth/* calls them (lib/gas-auth.ts).
export const WRITE_ACTIONS: readonly string[] = Object.freeze([
    'addTransaction',
    'addFixedCost',
    'deleteFixedCost',
    'deleteTransaction',
    'updateTransaction',
    'updateTransactionDate',
    'updateCategory',
]);

export function isWriteAction(action: unknown): boolean {
    return typeof action === 'string' && WRITE_ACTIONS.includes(action);
}

// A GAS `{ error }` answer for a list read. `gasError` is the GAS code.
export class GasResponseError extends Error {
    readonly gasError: string;
    constructor(gasError: string) {
        super(gasError);
        this.name = 'GasResponseError';
        this.gasError = gasError;
    }
}

// GAS answers both list endpoints (expenses and getFixedCosts) with a JSON
// array, and reports failures as a 200 `{ error }` object. Only an array may be
// returned (and therefore cached); everything else throws.
export function parseGasList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && 'error' in data) throw new GasResponseError(String((data as { error: unknown }).error));
    throw new Error('Unexpected response from GAS');
}

// HTTP status for GAS errors about the user (design §4.3, §5.7):
// - SessionRevoked (unknown / disabled user, epoch changed): 401, the cookie is
//   deleted and the client clears its cache and goes to /login
// - Forbidden (source outside the user's sources in the user table): 403
// - AuthUnavailable (user table missing / unreadable): 503
// Anything else (Unauthorized = proxy misconfiguration, Invalid actor, Busy,
// ...) is not the user's fault: null keeps the existing handling (GET 502,
// POST passes `{ error }` through) and never logs the user out.
export function gasErrorStatus(error: unknown): 401 | 403 | 503 | null {
    if (error === 'SessionRevoked') return 401;
    if (error === 'Forbidden') return 403;
    if (error === 'AuthUnavailable') return 503;
    return null;
}

// Fields only the proxy may set. A client-supplied value is always removed.
const SERVER_FIELDS: readonly string[] = ['key', 'authKey', 'actorUserId', 'actorEpoch'];

// Query forwarded to GAS for a list read, built only from the client's request.
// Proxy-only flags (`fresh`) and every server field are removed. The result is
// also the unstable_cache key, so it never contains a secret or the actor.
export function toGasQuery(searchParams: URLSearchParams): string {
    const query = new URLSearchParams(searchParams);
    query.delete('fresh');
    for (const field of SERVER_FIELDS) query.delete(field);
    return query.toString();
}

export interface GasCredentials {
    key?: string; // GAS_PROXY_SECRET (unset during its migration period)
    authKey?: string; // GAS_AUTH_PROXY_SECRET (required whenever an actor is sent)
    actor?: { userId: string; epoch: number }; // from the verified session
}

// Attach the server fields to a GAS query, right before the request is sent.
export function withGasAuth(query: string, { key, authKey, actor }: GasCredentials): string {
    const params = new URLSearchParams(query);
    for (const field of SERVER_FIELDS) params.delete(field);
    if (key) params.set('key', key);
    if (authKey) params.set('authKey', authKey);
    if (actor) {
        params.set('actorUserId', actor.userId);
        params.set('actorEpoch', String(actor.epoch));
    }
    return params.toString();
}

// POST body forwarded to GAS: client-supplied server fields are dropped and
// replaced by the server's values.
export function toGasBody(body: Record<string, unknown>, { key, authKey, actor }: GasCredentials): Record<string, unknown> {
    const rest: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(body)) {
        if (!SERVER_FIELDS.includes(name)) rest[name] = value;
    }
    if (key) rest.key = key;
    if (authKey) rest.authKey = authKey;
    if (actor) {
        rest.actorUserId = actor.userId;
        rest.actorEpoch = actor.epoch;
    }
    return rest;
}

// For logs: a message with every secret masked (transport errors may include
// the request URL, which carries `key` and `authKey`).
export function redactSecret(text: string, ...secrets: (string | undefined)[]): string {
    let result = text;
    for (const secret of secrets) {
        if (!secret) continue;
        // Secrets travel URL-encoded in GET queries, so mask every spelling
        const forms = new Set([secret, encodeURIComponent(secret), new URLSearchParams({ k: secret }).toString().slice(2)]);
        for (const form of forms) result = result.split(form).join('[redacted]');
    }
    return result;
}
