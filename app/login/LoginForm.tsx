'use client';

import { useState, useEffect, FormEvent, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { browserStorage, clearKakeiboStorage, rememberLoginUser } from "@/lib/client-session";
import { apiErrorMessage, ceremonyErrorMessage, isFresh, postAuthJson, safeRedirect } from "@/lib/passkey-client";

type CachedOptions = { options: PublicKeyCredentialRequestOptionsJSON; fetchedAt: number };

async function fetchLoginOptions(): Promise<CachedOptions | null> {
    const result = await postAuthJson('/api/auth/login/options');
    if (!result.ok || !result.data.options) return null;
    return { options: result.data.options as PublicKeyCredentialRequestOptionsJSON, fetchedAt: Date.now() };
}

export default function LoginForm({ passwordEnabled }: { passwordEnabled: boolean }) {
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [passkeySupported, setPasskeySupported] = useState(true);
    const optionsRef = useRef<CachedOptions | null>(null);
    const searchParams = useSearchParams();
    const returnTo = searchParams.get('returnTo');
    const sessionEnded = searchParams.get('reason') === 'session';

    // Sent here because the session was invalid, expired or revoked: remove
    // every cached list before anything else can show it (design §3.8)
    useEffect(() => {
        if (sessionEnded) clearKakeiboStorage();
    }, [sessionEnded]);

    // Fetch the login challenge ahead of the tap: iOS wants the WebAuthn call
    // directly in the tap handler, without a network wait before it
    useEffect(() => {
        if (!browserSupportsWebAuthn()) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- browser capability is only known on the client
            setPasskeySupported(false);
            return;
        }
        let cancelled = false;
        void fetchLoginOptions().then(options => {
            if (!cancelled && options) optionsRef.current = options;
        });
        return () => { cancelled = true; };
    }, []);

    // Successful login (either way): clear the cache if the user changed,
    // then a full navigation so no screen of the previous session survives.
    const finishLogin = useCallback((data: Record<string, unknown>) => {
        if (typeof data.userId === 'string') rememberLoginUser(browserStorage(), data.userId);
        window.location.assign(safeRedirect(data.redirectTo));
    }, []);

    const loginWithPasskey = async () => {
        setIsLoading(true);
        setError(null);
        let cached = isFresh(optionsRef.current?.fetchedAt ?? null) ? optionsRef.current : null;
        optionsRef.current = null; // one challenge per attempt (the server deletes it)
        if (!cached) cached = await fetchLoginOptions();
        if (!cached) {
            setError('ログインできませんでした。時間をおいて再度お試しください');
            setIsLoading(false);
            return;
        }
        let response;
        try {
            response = await startAuthentication({ optionsJSON: cached.options });
        } catch (e) {
            setError(ceremonyErrorMessage(e));
            setIsLoading(false);
            void fetchLoginOptions().then(options => { optionsRef.current = options; });
            return;
        }
        const result = await postAuthJson('/api/auth/login/verify', { response, returnTo });
        if (result.ok) {
            finishLogin(result.data);
            return; // stay "loading" until the page changes
        }
        setError(result.status === 401 ? 'このパスキーではログインできません' : apiErrorMessage(result));
        setIsLoading(false);
        void fetchLoginOptions().then(options => { optionsRef.current = options; });
    };

    const performLogin = useCallback(async (password: string) => {
        setIsLoading(true);
        setError(null);

        try {
            // returnTo is validated by the server (same-origin path of a
            // kakeibo this user may open); redirectTo is the result
            const res = await fetch("/api/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password, returnTo }),
            });

            if (res.ok) {
                finishLogin(await res.json() as Record<string, unknown>);
                return;
            } else {
                setError(res.status === 404
                    ? 'パスワードでのログインは終了しました'
                    : res.status === 401 ? 'Incorrect password' : 'ログインできませんでした。時間をおいて再度お試しください');
                // Clearing the input also stops the autofill auto-submit loop
                setInput("");
            }
        } catch {
            setError('ログインできませんでした。時間をおいて再度お試しください');
        }
        setIsLoading(false);
    }, [returnTo, finishLogin]);

    const handleLogin = (e: FormEvent) => {
        e.preventDefault();
        performLogin(input);
    };

    // Auto-submit when input is populated (Autofill detection)
    useEffect(() => {
        if (!passwordEnabled || !input) return;

        // Debounce to wait for autofill or end of typing
        const timer = setTimeout(() => {
            if (input.length > 3 && !isLoading) { // Assume min password length 4
                performLogin(input);
            }
        }, 800);

        return () => clearTimeout(timer);
    }, [input, isLoading, performLogin, passwordEnabled]);

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
                </div>

                <button
                    type="button"
                    onClick={() => { void loginWithPasskey(); }}
                    disabled={isLoading || !passkeySupported}
                    className={`w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all ${isLoading || !passkeySupported ? "opacity-70 cursor-not-allowed" : "active:scale-95"}`}
                >
                    {isLoading ? "確認中..." : "パスキーでログイン"}
                </button>
                {!passkeySupported && <p className="text-gray-500 text-xs mt-2 ml-1">このブラウザはパスキーに対応していません</p>}
                {error && <p className="text-red-500 text-xs mt-2 ml-1" role="alert">{error}</p>}

                {passwordEnabled && (
                    <form onSubmit={handleLogin} className="space-y-6 mt-8 pt-6 border-t border-gray-100">
                        <p className="text-gray-500 text-xs text-center">移行期間中はパスワードでもログインできます</p>
                        <div>
                            <input
                                type="password"
                                name="password"
                                autoComplete="current-password"
                                value={input}
                                onChange={(e) => {
                                    setInput(e.target.value);
                                    setError(null);
                                }}
                                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all text-gray-800 placeholder-gray-400"
                                placeholder="Password"
                                disabled={isLoading}
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={isLoading}
                            className={`w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-xl font-semibold transition-all ${isLoading ? "opacity-70 cursor-not-allowed" : "active:scale-95"}`}
                        >
                            {isLoading ? "Verifying..." : "パスワードでログイン"}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
