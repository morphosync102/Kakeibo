// Server-side only. Calls a GAS auth action (design §5.6, SPECIFICATION
// "認証API"): always POST, with `key` (GAS_PROXY_SECRET, when set) and
// `authKey` (GAS_AUTH_PROXY_SECRET, required). Only /api/auth/* routes use
// this; /api/expenses never forwards auth actions.
// Never logs: callers log `error` (a GAS code or a fixed word), never secrets.

import { redactSecret } from './expenses-proxy.ts';

export interface GasAuthEnv {
    GAS_API_URL?: string;
    GAS_PROXY_SECRET?: string;
    GAS_AUTH_PROXY_SECRET?: string;
    [name: string]: string | undefined;
}

export type GasAuthResult =
    | { ok: true; data: Record<string, unknown> }
    // error: the GAS error code (e.g. 'AdminNotFound', 'SessionRevoked'),
    // 'NotConfigured' (no URL / authKey), 'BadGateway' (HTTP / non-JSON / no
    // success flag) or 'Unavailable' (transport error; detail is redacted)
    | { ok: false; error: string; detail?: string };

export function isGasAuthConfigured(env: GasAuthEnv): boolean {
    return Boolean(env.GAS_API_URL) && Boolean(env.GAS_AUTH_PROXY_SECRET);
}

export async function callGasAuth(
    action: string,
    payload: Record<string, unknown>,
    { env, fetchImpl = fetch }: { env: GasAuthEnv; fetchImpl?: typeof fetch },
): Promise<GasAuthResult> {
    if (!isGasAuthConfigured(env)) return { ok: false, error: 'NotConfigured' };
    const body: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(payload)) {
        if (name !== 'action' && name !== 'key' && name !== 'authKey') body[name] = value;
    }
    body.action = action;
    if (env.GAS_PROXY_SECRET) body.key = env.GAS_PROXY_SECRET;
    body.authKey = env.GAS_AUTH_PROXY_SECRET;
    let data: unknown;
    try {
        const res = await fetchImpl(env.GAS_API_URL as string, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) return { ok: false, error: 'BadGateway', detail: `GAS responded ${res.status}` };
        data = await res.json();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: 'Unavailable', detail: redactSecret(message, env.GAS_PROXY_SECRET, env.GAS_AUTH_PROXY_SECRET) };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'BadGateway' };
    const record = data as Record<string, unknown>;
    if (typeof record.error === 'string') return { ok: false, error: record.error };
    if (record.success !== true) return { ok: false, error: 'BadGateway' };
    return { ok: true, data: record };
}
