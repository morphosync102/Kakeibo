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

// GAS answers both list endpoints (expenses and getFixedCosts) with a JSON
// array, and reports failures as a 200 `{ error }` object. Only an array may be
// returned (and therefore cached); everything else throws.
export function parseGasList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    const message = data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : 'Unexpected response from GAS';
    throw new Error(message);
}

// Query forwarded to GAS for a list read, built only from the client's request.
// Proxy-only flags (`fresh`) and any client-supplied `key` are removed. The
// result is also the unstable_cache key, so it must never contain the secret.
export function toGasQuery(searchParams: URLSearchParams): string {
    const query = new URLSearchParams(searchParams);
    query.delete('fresh');
    query.delete('key');
    return query.toString();
}

// Attach the GAS proxy secret (GAS_PROXY_SECRET) as `key`. Without a secret
// (migration period) the query is returned unchanged.
export function withGasKey(query: string, secret: string | undefined): string {
    if (!secret) return query;
    const params = new URLSearchParams(query);
    params.set('key', secret);
    return params.toString();
}

// POST body forwarded to GAS: a client-supplied `key` is always dropped and
// replaced by the secret when one is configured.
export function toGasBody(body: Record<string, unknown>, secret: string | undefined): Record<string, unknown> {
    const { key: _clientKey, ...rest } = body;
    void _clientKey;
    return secret ? { ...rest, key: secret } : rest;
}

// For logs: an error message with the secret masked (transport errors may
// include the request URL, which carries the key).
export function redactSecret(text: string, secret: string | undefined): string {
    if (!secret) return text;
    // The secret travels URL-encoded in GET queries, so mask both spellings
    const forms = new Set([secret, encodeURIComponent(secret), new URLSearchParams({ k: secret }).toString().slice(2)]);
    let result = text;
    for (const form of forms) result = result.split(form).join('[redacted]');
    return result;
}
