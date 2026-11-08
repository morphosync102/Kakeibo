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
    CredentialNotFound: 'そのパスキーは見つかりません(失効済みの可能性があります)',
    NoCandidate: '確認待ちの LINE がありません。コードを発行し直してください',
    ProfileUnavailable: 'LINE の名前を取得できませんでした。時間をおいて再度お試しください',
});

// A 401 that ends the screen: the session is gone (Unauthorized) or the app
// is locked (Locked, design §3.12). Pass result.data.error to
// lib/client-session.ts handleUnauthorized. Other 401s (VerificationFailed)
// are shown as messages.
export function isSessionFailure(result: ApiResult): boolean {
    return result.status === 401 && (result.data.error === 'Unauthorized' || result.data.error === 'Locked');
}

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

// /invite: the token is removed from the address bar at once, except in an
// in-app browser, where "Open in Safari" hands over the current URL and needs
// the fragment (removing it broke registrations started from LINE). The
// token is one-time, valid 24 hours and consumed by the registration.
export function shouldClearInviteFragment(userAgent: string): boolean {
    return !isInAppBrowser(userAgent);
}

export const INVITE_COPY_TO_SAFARI_HINT = 'うまくいかない場合は、届いたリンクを長押しでコピーし、Safari のアドレス欄に貼り付けて開いてください(iMessage で送ってもらうと確実です)。';
export const INVITE_IN_APP_BROWSER_NOTICE = `LINE などのアプリ内ブラウザでは登録できないことがあります。右下(または右上)のメニューから「Safariで開く」を選んでください。${INVITE_COPY_TO_SAFARI_HINT}`;
export const INVITE_MISSING_TOKEN_MESSAGE = `招待リンクが正しくありません。${INVITE_COPY_TO_SAFARI_HINT}`;

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
// browser has WebAuthn, it is not an in-app browser and the user did not just
// log out (the app lock screen, reason=locked, starts it too).
export function shouldAutoStartPasskey(c: {
    optionsReady: boolean;
    supported: boolean;
    inAppBrowser: boolean;
    loggedOut: boolean;
}): boolean {
    return c.optionsReady && c.supported && !c.inAppBrowser && !c.loggedOut;
}

// /login?reason=locked: the app lock screen (design §3.12)
export function isLockedLanding(searchParams: { get(name: string): string | null }): boolean {
    return searchParams.get('reason') === 'locked';
}

export const LOCKED_NOTICE = 'しばらく操作がなかったため、ロックしました。顔認証で再開します。';

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
