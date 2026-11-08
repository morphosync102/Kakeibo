'use client';

import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { browserStorage, rememberLoginUser } from "@/lib/client-session";
import { markAppActive } from "@/lib/app-lock";
import {
    apiErrorMessage, ceremonyErrorMessage, INVITE_IN_APP_BROWSER_NOTICE, INVITE_MISSING_TOKEN_MESSAGE, inviteTokenFromHash,
    isFresh, isInAppBrowser, postAuthJson, safeRedirect, shouldClearInviteFragment,
} from "@/lib/passkey-client";

// Passkey registration from an invite link /invite#<token> (design §3.3,
// §3.11). The token stays in the URL fragment (never sent to the server as
// a URL, so it is not in access logs or Referer) and is removed from the
// address bar at once, except in an in-app browser (LINE etc.), where "Open
// in Safari" hands over the current URL and needs it; it is then removed
// after the registration. Only the server-side routes see it, in a POST
// body, and pass only its SHA-256 to GAS.

type Phase = 'loading' | 'invalid' | 'unsupported' | 'ready' | 'registering' | 'done';
type CachedOptions = { options: PublicKeyCredentialCreationOptionsJSON; fetchedAt: number };

export default function InvitePage() {
    const [phase, setPhase] = useState<Phase>('loading');
    const [error, setError] = useState<string | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [inAppBrowser, setInAppBrowser] = useState(false);
    const [redirectTo, setRedirectTo] = useState('/');
    const tokenRef = useRef<string | null>(null);
    const optionsRef = useRef<CachedOptions | null>(null);

    const loadOptions = async (): Promise<CachedOptions | null> => {
        const token = tokenRef.current;
        if (!token) return null;
        const result = await postAuthJson('/api/auth/register/options', { token });
        if (!result.ok || !result.data.options) {
            setError(apiErrorMessage(result));
            if (result.status === 410) setPhase('invalid');
            return null;
        }
        if (typeof result.data.displayName === 'string') setDisplayName(result.data.displayName);
        return { options: result.data.options as PublicKeyCredentialCreationOptionsJSON, fetchedAt: Date.now() };
    };

    useEffect(() => {
        const token = inviteTokenFromHash(window.location.hash);
        // Remove the token from the address bar and history, except in an
        // in-app browser: "Open in Safari" needs it in the URL
        if (shouldClearInviteFragment(navigator.userAgent)) window.history.replaceState(null, '', '/invite');
        tokenRef.current = token;
        // The fragment and browser capabilities are only known on the client
        // eslint-disable-next-line react-hooks/set-state-in-effect -- read once on arrival
        setInAppBrowser(isInAppBrowser(navigator.userAgent));
        if (!token) {
            setPhase('invalid');
            setError(INVITE_MISSING_TOKEN_MESSAGE);
            return;
        }
        if (!browserSupportsWebAuthn()) {
            setPhase('unsupported');
            return;
        }
        void loadOptions().then(options => {
            optionsRef.current = options;
            if (options) setPhase('ready');
        });
    }, []);

    const register = async () => {
        setError(null);
        setPhase('registering');
        let cached = isFresh(optionsRef.current?.fetchedAt ?? null) ? optionsRef.current : null;
        optionsRef.current = null;
        if (!cached) cached = await loadOptions();
        if (!cached) {
            setPhase(current => (current === 'invalid' ? current : 'ready'));
            return;
        }
        let response;
        try {
            response = await startRegistration({ optionsJSON: cached.options });
        } catch (e) {
            setError(ceremonyErrorMessage(e));
            setPhase('ready');
            return;
        }
        const result = await postAuthJson('/api/auth/register/verify', { token: tokenRef.current, response });
        if (!result.ok) {
            setError(apiErrorMessage(result));
            setPhase(result.status === 410 ? 'invalid' : 'ready');
            return;
        }
        tokenRef.current = null;
        // The invite is consumed: drop the token from the URL in every browser
        window.history.replaceState(null, '', '/invite');
        // A new user on this device: clear the previous user's cache; the
        // app lock's idle clock starts now (§3.12)
        const storage = browserStorage();
        if (typeof result.data.userId === 'string') rememberLoginUser(storage, result.data.userId);
        markAppActive(storage);
        setRedirectTo(safeRedirect(result.data.redirectTo));
        setPhase('done');
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
            <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm space-y-4">
                <h1 className="text-xl font-bold text-gray-800 text-center">パスキーの登録</h1>

                {inAppBrowser && phase !== 'done' && (
                    <p className="text-amber-700 bg-amber-50 rounded-lg p-3 text-sm">
                        {INVITE_IN_APP_BROWSER_NOTICE}
                    </p>
                )}

                {phase === 'loading' && <p className="text-gray-500 text-sm text-center">招待を確認しています...</p>}

                {phase === 'unsupported' && (
                    <p className="text-gray-600 text-sm">このブラウザはパスキーに対応していません。iPhone の Safari で開いてください。</p>
                )}

                {(phase === 'ready' || phase === 'registering') && (
                    <>
                        <p className="text-gray-600 text-sm">
                            {displayName ? `${displayName} さんの` : ''}家計簿にログインするためのパスキーをこの端末に登録します。Face ID などで確認します。
                        </p>
                        <button
                            type="button"
                            onClick={() => { void register(); }}
                            disabled={phase === 'registering'}
                            className={`w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all ${phase === 'registering' ? "opacity-70 cursor-not-allowed" : "active:scale-95"}`}
                        >
                            {phase === 'registering' ? '登録中...' : 'パスキーを登録'}
                        </button>
                    </>
                )}

                {phase === 'done' && (
                    <>
                        <p className="text-gray-700 text-sm font-semibold">登録しました。</p>
                        <ul className="text-gray-600 text-sm list-disc pl-5 space-y-1">
                            <li>Safari の共有ボタンから「ホーム画面に追加」すると、アプリのように使えます。</li>
                            <li>ホーム画面のアプリは Safari とログイン状態が別です。最初に開いたときに顔認証が始まらなければ「顔認証でログイン」を押してください。</li>
                        </ul>
                        <button
                            type="button"
                            onClick={() => window.location.assign(redirectTo)}
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all active:scale-95"
                        >
                            家計簿を開く
                        </button>
                    </>
                )}

                {error && <p className="text-red-500 text-sm" role="alert">{error}</p>}
            </div>
        </div>
    );
}
