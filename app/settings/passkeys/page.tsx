'use client';

import { useEffect, useRef, useState, FormEvent } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { handleSessionExpired } from "@/lib/client-session";
import { apiErrorMessage, ceremonyErrorMessage, postAuthJson, type ApiResult } from "@/lib/passkey-client";

// Add a passkey for the signed-in user (design §3.3). A session alone is not
// enough: first re-authenticate with an existing passkey, then register the
// new one (two taps, since iOS wants each WebAuthn call in its own tap).
// Only the admin without any passkey (bootstrap, migration period) re-enters
// the shared password instead. The list / revoke / all-device logout are U4.

type Phase =
    | 'loading' | 'unsupported' | 'failed'
    | 'reauth' | 'bootstrap' | 'working'
    | 'register' | 'done';

export default function PasskeysPage() {
    const [phase, setPhase] = useState<Phase>('loading');
    const [error, setError] = useState<string | null>(null);
    const [password, setPassword] = useState('');
    const [credentialCount, setCredentialCount] = useState<number | null>(null);
    const reauthOptions = useRef<PublicKeyCredentialRequestOptionsJSON | null>(null);
    const registerOptions = useRef<PublicKeyCredentialCreationOptionsJSON | null>(null);

    // 401: the session ended (expired, revoked): clear the cache, go to /login
    const failWith = (result: ApiResult, next: Phase) => {
        if (result.status === 401 && result.data.error === 'Unauthorized') {
            handleSessionExpired();
            return;
        }
        setError(apiErrorMessage(result));
        setPhase(next);
    };

    const start = async () => {
        setError(null);
        setPhase('loading');
        const result = await postAuthJson('/api/auth/passkeys/add/options');
        if (!result.ok) return failWith(result, 'failed');
        if (result.data.mode === 'bootstrap') return setPhase('bootstrap');
        reauthOptions.current = result.data.options as PublicKeyCredentialRequestOptionsJSON;
        setPhase('reauth');
    };

    useEffect(() => {
        if (!browserSupportsWebAuthn()) {
            setPhase('unsupported'); // browser capability is only known on the client
            return;
        }
        void start();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
    }, []);

    const reauthenticate = async () => {
        const options = reauthOptions.current;
        reauthOptions.current = null;
        if (!options) return void start();
        setError(null);
        setPhase('working');
        let response;
        try {
            response = await startAuthentication({ optionsJSON: options });
        } catch (e) {
            setError(ceremonyErrorMessage(e));
            return void start();
        }
        const result = await postAuthJson('/api/auth/passkeys/add/reauth', { response });
        if (!result.ok) {
            failWith(result, 'failed');
            return;
        }
        registerOptions.current = result.data.options as PublicKeyCredentialCreationOptionsJSON;
        setPhase('register');
    };

    const bootstrap = async (e: FormEvent) => {
        e.preventDefault();
        setError(null);
        setPhase('working');
        const result = await postAuthJson('/api/auth/passkeys/add/bootstrap', { password });
        setPassword('');
        if (!result.ok) {
            if (result.status === 401 && result.data.error === 'Incorrect password') {
                setError(apiErrorMessage(result));
                setPhase('bootstrap');
                return;
            }
            failWith(result, 'failed');
            return;
        }
        registerOptions.current = result.data.options as PublicKeyCredentialCreationOptionsJSON;
        setPhase('register');
    };

    const register = async () => {
        const options = registerOptions.current;
        registerOptions.current = null;
        if (!options) return void start();
        setError(null);
        setPhase('working');
        let response;
        try {
            response = await startRegistration({ optionsJSON: options });
        } catch (e) {
            // The registration challenge is spent: start over (re-authenticate)
            setError(ceremonyErrorMessage(e));
            setPhase('failed');
            return;
        }
        const result = await postAuthJson('/api/auth/passkeys/add/verify', { response });
        if (!result.ok) {
            failWith(result, 'failed');
            return;
        }
        setCredentialCount(typeof result.data.credentialCount === 'number' ? result.data.credentialCount : null);
        setPhase('done');
    };

    const buttonClass = (disabled: boolean) =>
        `w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all ${disabled ? "opacity-70 cursor-not-allowed" : "active:scale-95"}`;

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
            <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm space-y-4">
                <h1 className="text-xl font-bold text-gray-800 text-center">パスキーを追加</h1>

                {phase === 'loading' && <p className="text-gray-500 text-sm text-center">確認しています...</p>}
                {phase === 'unsupported' && <p className="text-gray-600 text-sm">このブラウザはパスキーに対応していません。</p>}

                {phase === 'reauth' && (
                    <>
                        <p className="text-gray-600 text-sm">追加の前に、登録済みのパスキーで本人確認をします。</p>
                        <button type="button" onClick={() => { void reauthenticate(); }} className={buttonClass(false)}>
                            登録済みのパスキーで確認
                        </button>
                    </>
                )}

                {phase === 'bootstrap' && (
                    <form onSubmit={bootstrap} className="space-y-4">
                        <p className="text-gray-600 text-sm">
                            まだパスキーがありません。最初の1つは、本人確認としてパスワードを入力してください(管理者のみ)。
                        </p>
                        <input
                            type="password"
                            name="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            className="w-full px-4 py-3 rounded-lg border border-gray-300 outline-none text-gray-800"
                            placeholder="Password"
                        />
                        <button type="submit" disabled={password.length === 0} className={buttonClass(password.length === 0)}>
                            確認
                        </button>
                    </form>
                )}

                {phase === 'working' && <p className="text-gray-500 text-sm text-center">処理しています...</p>}

                {phase === 'register' && (
                    <>
                        <p className="text-gray-600 text-sm">本人確認ができました。この端末(または追加したい認証器)で新しいパスキーを登録します。</p>
                        <button type="button" onClick={() => { void register(); }} className={buttonClass(false)}>
                            新しいパスキーを登録
                        </button>
                    </>
                )}

                {phase === 'done' && (
                    <>
                        <p className="text-gray-700 text-sm font-semibold">パスキーを追加しました。</p>
                        {credentialCount === 1 && (
                            <p className="text-amber-700 bg-amber-50 rounded-lg p-3 text-sm">
                                パスキーが1つだけです。端末の紛失に備えて、もう1台の端末などで2つ目を追加しておくことをおすすめします。
                            </p>
                        )}
                    </>
                )}

                {phase === 'failed' && (
                    <button type="button" onClick={() => { void start(); }} className={buttonClass(false)}>
                        最初からやり直す
                    </button>
                )}

                {error && <p className="text-red-500 text-sm" role="alert">{error}</p>}

                <button type="button" onClick={() => window.history.back()} className="w-full text-sm text-gray-500 underline">
                    戻る
                </button>
            </div>
        </div>
    );
}
