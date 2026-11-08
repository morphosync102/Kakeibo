'use client';

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { browserStorage, clearKakeiboStorage, rememberLoginUser } from "@/lib/client-session";
import { markAppActive } from "@/lib/app-lock";
import {
    apiErrorMessage, ceremonyFailureMessage, createAutoStartGate, isFresh, isInAppBrowser, isLockedLanding, isLoggedOutLanding,
    LOCKED_NOTICE, postAuthJson, safeRedirect, shouldAutoStartPasskey,
} from "@/lib/passkey-client";

type CachedOptions = { options: PublicKeyCredentialRequestOptionsJSON; fetchedAt: number };

async function fetchLoginOptions(): Promise<CachedOptions | null> {
    const result = await postAuthJson('/api/auth/login/options');
    if (!result.ok || !result.data.options) return null;
    return { options: result.data.options as PublicKeyCredentialRequestOptionsJSON, fetchedAt: Date.now() };
}

// Passkey login only (the shared password was removed, design §11 U6). Also
// the app lock screen (?reason=locked, §3.12): same flow, the cache is kept.
export default function LoginForm() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [passkeySupported, setPasskeySupported] = useState(true);
    const [inAppBrowser, setInAppBrowser] = useState(false);
    const [optionsReady, setOptionsReady] = useState(false);
    const [autoFailed, setAutoFailed] = useState(false);
    const optionsRef = useRef<CachedOptions | null>(null);
    const autoStart = useRef(createAutoStartGate());
    const searchParams = useSearchParams();
    const returnTo = searchParams.get('returnTo');
    const sessionEnded = searchParams.get('reason') === 'session';
    const locked = isLockedLanding(searchParams);
    const loggedOut = isLoggedOutLanding(searchParams);

    // Sent here because the session was invalid, expired or revoked: remove
    // every cached list before anything else can show it (design §3.8).
    // A lock (reason=locked) keeps them: same user, same session.
    useEffect(() => {
        if (sessionEnded) clearKakeiboStorage();
    }, [sessionEnded]);

    // Fetch the login challenge ahead of the tap: iOS wants the WebAuthn call
    // directly in the tap handler, without a network wait before it
    useEffect(() => {
        // browser capabilities are only known on the client
        // eslint-disable-next-line react-hooks/set-state-in-effect -- read once on arrival
        setInAppBrowser(isInAppBrowser(navigator.userAgent));
        if (!browserSupportsWebAuthn()) {
            setPasskeySupported(false);
            return;
        }
        let cancelled = false;
        void fetchLoginOptions().then(options => {
            if (cancelled || !options) return;
            optionsRef.current = options;
            setOptionsReady(true);
        });
        return () => { cancelled = true; };
    }, []);

    // Successful login: clear the cache if the user changed, restart the app
    // lock's idle clock, then a full navigation so no screen of the previous
    // session survives.
    const finishLogin = useCallback((data: Record<string, unknown>) => {
        const storage = browserStorage();
        if (typeof data.userId === 'string') rememberLoginUser(storage, data.userId);
        markAppActive(storage);
        window.location.assign(safeRedirect(data.redirectTo));
    }, []);

    const refetchOptions = useCallback(() => {
        void fetchLoginOptions().then(options => { optionsRef.current = options; });
    }, []);

    // auto: the one automatic attempt on arrival. If the browser refuses it
    // (iOS without a tap) or the user cancels, the button is shown quietly.
    const loginWithPasskey = useCallback(async ({ auto }: { auto: boolean }) => {
        setIsLoading(true);
        setError(null);
        let cached = isFresh(optionsRef.current?.fetchedAt ?? null) ? optionsRef.current : null;
        optionsRef.current = null; // one challenge per attempt (the server deletes it)
        if (!cached) cached = await fetchLoginOptions();
        if (!cached) {
            if (!auto) setError('ログインできませんでした。時間をおいて再度お試しください');
            setAutoFailed(auto);
            setIsLoading(false);
            return;
        }
        let response;
        try {
            response = await startAuthentication({ optionsJSON: cached.options });
        } catch (e) {
            setError(ceremonyFailureMessage(e, { auto }));
            setAutoFailed(auto);
            setIsLoading(false);
            refetchOptions();
            return;
        }
        const result = await postAuthJson('/api/auth/login/verify', { response, returnTo });
        if (result.ok) {
            finishLogin(result.data);
            return; // stay "loading" until the page changes
        }
        // The user did authenticate: a refusal here is always explained
        setError(result.status === 401 ? 'このパスキーではログインできません' : apiErrorMessage(result));
        setIsLoading(false);
        refetchOptions();
    }, [returnTo, finishLogin, refetchOptions]);

    // Start Face ID by itself once the challenge is ready (at most once per
    // page; never right after a logout or in an in-app browser)
    useEffect(() => {
        const allowed = shouldAutoStartPasskey({
            optionsReady,
            supported: passkeySupported,
            inAppBrowser,
            loggedOut,
        });
        if (autoStart.current.tryStart(allowed)) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- starts an async ceremony once
            void loginWithPasskey({ auto: true });
        }
    }, [optionsReady, passkeySupported, inAppBrowser, loggedOut, loginWithPasskey]);

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
            <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm">
                <div className="text-center mb-8">
                    <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                    </div>
                    <h1 className="text-2xl font-bold text-gray-800">Kakeibo Secured</h1>
                    <p className="text-gray-500 text-sm mt-1">Face ID などのパスキーでログインします</p>
                    {locked && <p className="text-gray-600 text-xs mt-3">{LOCKED_NOTICE}</p>}
                </div>

                <button
                    type="button"
                    onClick={() => { void loginWithPasskey({ auto: false }); }}
                    disabled={isLoading || !passkeySupported}
                    className={`w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all ${isLoading || !passkeySupported ? "opacity-70 cursor-not-allowed" : "active:scale-95"}`}
                >
                    {isLoading ? "確認中..." : "顔認証でログイン"}
                </button>
                {!passkeySupported && <p className="text-gray-500 text-xs mt-2 ml-1">このブラウザはパスキーに対応していません</p>}
                {autoFailed && !error && !isLoading && <p className="text-gray-400 text-xs mt-2 ml-1">ボタンを押すと顔認証が始まります</p>}
                {error && <p className="text-red-500 text-xs mt-2 ml-1" role="alert">{error}</p>}
                <p className="text-gray-400 text-xs mt-6 text-center">パスキーを使えなくなったときは、管理者に復旧用の招待リンクを依頼してください</p>
            </div>
        </div>
    );
}
