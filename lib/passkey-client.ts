// Client-side helpers of the passkey screens (/login, /invite,
// /settings/passkeys). Messages are fixed Japanese texts chosen by the error
// word of the API or the WebAuthn error name; nothing from the server or the
// browser is shown verbatim.
// No imports: node --test loads it directly.

export interface ApiResult {
    ok: boolean;
    status: number;
    data: Record<string, unknown>;
}

// POST JSON to one of our /api/auth/* routes. Never throws: a network error
// is { ok: false, status: 0 }.
export async function postAuthJson(url: string, body: unknown = {}, fetchImpl: typeof fetch = fetch): Promise<ApiResult> {
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            cache: 'no-store',
        });
        let data: unknown = {};
        try {
            data = await res.json();
        } catch {
            data = {};
        }
        return { ok: res.ok, status: res.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {} };
    } catch {
        return { ok: false, status: 0, data: {} };
    }
}

const API_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
    InviteInvalid: '招待リンクが無効か、期限切れか、使用済みです。管理者に新しいリンクを依頼してください',
    CredentialExists: 'このパスキーは登録済みです',
    ChallengeInvalid: '時間が経ちすぎたか、別の画面で操作されました。もう一度お試しください',
    VerificationFailed: 'パスキーを確認できませんでした。もう一度お試しください',
    NotAllowed: 'この操作はできません',
    Unauthorized: 'ログインし直してください',
    'Incorrect password': 'パスワードが違います',
    'Not Found': 'パスワードでの確認は終了しました',
    CredentialNotFound: 'そのパスキーは見つかりません(失効済みの可能性があります)',
    NoCandidate: '確認待ちの LINE がありません。コードを発行し直してください',
    ProfileUnavailable: 'LINE の名前を取得できませんでした。時間をおいて再度お試しください',
});

export const GENERIC_ERROR_MESSAGE = 'うまくいきませんでした。時間をおいて再度お試しください';

export function apiErrorMessage(result: ApiResult): string {
    const code = typeof result.data.error === 'string' ? result.data.error : '';
    return Object.prototype.hasOwnProperty.call(API_MESSAGES, code) ? API_MESSAGES[code] : GENERIC_ERROR_MESSAGE;
}

// A rejected navigator.credentials call (from @simplewebauthn/browser)
export function ceremonyErrorMessage(error: unknown): string {
    const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') return 'この端末のパスキーは登録済みです';
    if (name === 'NotAllowedError' || name === 'AbortError') return 'キャンセルされたか、時間切れになりました';
    if (name === 'SecurityError') return 'このアドレスではパスキーを使えません';
    return 'パスキーを使えませんでした。もう一度お試しください';
}

// The invite token of /invite#<token>, or null
export function inviteTokenFromHash(hash: string): string | null {
    const token = hash.startsWith('#') ? hash.slice(1) : hash;
    return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}

// In-app browsers (LINE, Instagram, Facebook, ...) where passkey registration
// may fail: /invite asks to open the link in Safari instead.
export function isInAppBrowser(userAgent: string): boolean {
    return /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|KAKAOTALK|Twitter/i.test(userAgent);
}

// A redirect target from our API (same-origin path) or the fallback
export function safeRedirect(value: unknown, fallback = '/'): string {
    return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
}

// The failure text of a WebAuthn call: none for the automatic attempt on
// /login (iOS may refuse a call without a tap, or the user cancelled: the
// button is simply shown), the usual text for a tapped attempt.
export function ceremonyFailureMessage(error: unknown, { auto }: { auto: boolean }): string | null {
    return auto ? null : ceremonyErrorMessage(error);
}

// /login reached by a logout (lib/client-session.ts LOGGED_OUT_PATH)
export function isLoggedOutLanding(searchParams: { get(name: string): string | null }): boolean {
    return searchParams.get('loggedOut') === '1';
}

// /login starts the passkey by itself only when the challenge is ready, the
// browser has WebAuthn, it is not an in-app browser, the user did not just
// log out and is not typing the password.
export function shouldAutoStartPasskey(c: {
    optionsReady: boolean;
    supported: boolean;
    inAppBrowser: boolean;
    loggedOut: boolean;
    typingPassword: boolean;
}): boolean {
    return c.optionsReady && c.supported && !c.inAppBrowser && !c.loggedOut && !c.typingPassword;
}

// At most one automatic attempt per page (never a retry loop)
export function createAutoStartGate() {
    const gate = {
        started: false,
        tryStart(allowed: boolean): boolean {
            if (gate.started || !allowed) return false;
            gate.started = true;
            return true;
        },
    };
    return gate;
}

// Options fetched ahead of the tap (iOS wants the WebAuthn call right in the
// tap handler). The challenge cookie lives 5 minutes; reuse for 4 at most.
export const OPTIONS_MAX_AGE_MS = 4 * 60 * 1000;

export function isFresh(fetchedAt: number | null, now = Date.now()): boolean {
    return fetchedAt !== null && now - fetchedAt < OPTIONS_MAX_AGE_MS;
}
