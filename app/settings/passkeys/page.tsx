'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { handleUnauthorized, logout } from "@/lib/client-session";
import { apiErrorMessage, ceremonyErrorMessage, isSessionFailure, postAuthJson, type ApiResult } from "@/lib/passkey-client";

// The signed-in user's passkeys (design §3.3, §3.8, §3.9):
// - list of the user's own passkeys, revoke one (U4)
// - "log out on every device" (U4)
// - add a passkey (U3): a session alone is not enough: first re-authenticate
//   with an existing passkey, then register the new one (two taps, since iOS
//   wants each WebAuthn call in its own tap). There is no password path: a
//   user without passkeys needs a recovery invite (GAS editor).
// Revoking a passkey and logging out everywhere end every session of the
// user, this one included (epoch +1): the cache is cleared and /login opens.

type Phase =
    | 'idle' | 'loading' | 'unsupported' | 'failed'
    | 'reauth' | 'working'
    | 'register' | 'done';

interface PasskeyItem {
    credentialId: string;
    label: string;
    synced: boolean;
    createdAt: string;
    lastUsedAt: string;
}

function formatDate(value: string): string {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('ja-JP') : '-';
}

export default function PasskeysPage() {
    const [phase, setPhase] = useState<Phase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [credentialCount, setCredentialCount] = useState<number | null>(null);
    const [passkeys, setPasskeys] = useState<PasskeyItem[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null); // credentialId or 'all'
    const [busy, setBusy] = useState(false);
    const reauthOptions = useRef<PublicKeyCredentialRequestOptionsJSON | null>(null);
    const registerOptions = useRef<PublicKeyCredentialCreationOptionsJSON | null>(null);

    // 401: the session ended (expired, revoked): clear the cache, go to
    // /login; or the app is locked: keep the cache, open the lock screen
    const failWith = (result: ApiResult, next: Phase) => {
        if (isSessionFailure(result)) {
            handleUnauthorized(result.data.error);
            return;
        }
        setError(apiErrorMessage(result));
        setPhase(next);
    };

    const loadList = useCallback(async () => {
        const result = await postAuthJson('/api/auth/passkeys/list');
        if (!result.ok) {
            if (isSessionFailure(result)) return handleUnauthorized(result.data.error);
            setListError(apiErrorMessage(result));
            return;
        }
        setListError(null);
        setPasskeys(Array.isArray(result.data.credentials) ? result.data.credentials as PasskeyItem[] : []);
    }, []);

    useEffect(() => {
        if (!browserSupportsWebAuthn()) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- browser capability is only known on the client
            setPhase('unsupported');
        }
        void loadList();
    }, [loadList]);

    // Every session of this user has ended (epoch +1; the server already
    // deleted this cookie): leave like a logout (cache cleared, /login)
    const endedEverywhere = () => { void logout(); };

    const revoke = async (credentialId: string) => {
        if (confirming !== credentialId) return setConfirming(credentialId); // second tap confirms
        setConfirming(null);
        setBusy(true);
        const result = await postAuthJson('/api/auth/passkeys/revoke', { credentialId });
        if (result.ok) return endedEverywhere();
        setBusy(false);
        if (isSessionFailure(result)) return handleUnauthorized(result.data.error);
        setListError(apiErrorMessage(result));
        void loadList();
    };

    const logoutEverywhere = async () => {
        if (confirming !== 'all') return setConfirming('all');
        setConfirming(null);
        setBusy(true);
        const result = await postAuthJson('/api/auth/logout/all');
        if (result.ok) return endedEverywhere();
        setBusy(false);
        if (isSessionFailure(result)) return handleUnauthorized(result.data.error);
        setListError(apiErrorMessage(result));
    };

    const start = async () => {
        setError(null);
        setPhase('loading');
        const result = await postAuthJson('/api/auth/passkeys/add/options');
        if (!result.ok) return failWith(result, 'failed');
        reauthOptions.current = result.data.options as PublicKeyCredentialRequestOptionsJSON;
        setPhase('reauth');
    };

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
        void loadList();
    };

    const buttonClass = (disabled: boolean) =>
        `w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all ${disabled ? "opacity-70 cursor-not-allowed" : "active:scale-95"}`;
    const dangerClass = (armed: boolean) =>
        `text-sm px-3 py-1 rounded-lg border ${armed ? "bg-red-600 border-red-600 text-white" : "border-red-300 text-red-600"}`;

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
            <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm space-y-6">
                <h1 className="text-xl font-bold text-gray-800 text-center">パスキー</h1>

                <section className="space-y-3">
                    <h2 className="text-sm font-semibold text-gray-700">登録済みのパスキー</h2>
                    {passkeys === null && !listError && <p className="text-gray-500 text-sm">読み込んでいます...</p>}
                    {passkeys !== null && passkeys.length === 0 && <p className="text-gray-500 text-sm">まだありません。</p>}
                    {passkeys !== null && passkeys.length === 1 && (
                        <p className="text-amber-700 bg-amber-50 rounded-lg p-3 text-sm">
                            パスキーが1つだけです。端末の紛失に備えて、もう1台の端末などで2つ目を追加しておくことをおすすめします。
                        </p>
                    )}
                    <ul className="space-y-2">
                        {(passkeys ?? []).map(item => (
                            <li key={item.credentialId} className="flex items-center justify-between gap-2 border border-gray-100 rounded-lg p-3">
                                <div className="text-sm text-gray-700 min-w-0">
                                    <p className="font-semibold truncate">{item.label}{item.synced ? '(同期)' : ''}</p>
                                    <p className="text-xs text-gray-500">登録 {formatDate(item.createdAt)} / 最終利用 {formatDate(item.lastUsedAt)}</p>
                                </div>
                                <button type="button" disabled={busy} onClick={() => { void revoke(item.credentialId); }} className={dangerClass(confirming === item.credentialId)}>
                                    {confirming === item.credentialId ? '失効する' : '失効'}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {confirming !== null && confirming !== 'all' && (
                        <p className="text-xs text-gray-600">
                            失効すると、そのパスキーではログインできなくなり、すべての端末(この端末も)がログアウトします。
                            {passkeys?.length === 1 ? ' 最後のパスキーです。失効すると管理者の招待が必要になります。' : ''}
                        </p>
                    )}
                    {listError && <p className="text-red-500 text-sm" role="alert">{listError}</p>}
                </section>

                <section className="space-y-3">
                    <h2 className="text-sm font-semibold text-gray-700">パスキーを追加</h2>

                    {phase === 'idle' && (
                        <button type="button" onClick={() => { void start(); }} className={buttonClass(false)}>
                            パスキーを追加
                        </button>
                    )}
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
                </section>

                <section className="space-y-2">
                    <h2 className="text-sm font-semibold text-gray-700">すべての端末からログアウト</h2>
                    <p className="text-xs text-gray-600">端末を紛失したときなどに。この端末も含め、ログイン中のすべての端末でログインし直しが必要になります。</p>
                    <button type="button" disabled={busy} onClick={() => { void logoutEverywhere(); }} className={dangerClass(confirming === 'all')}>
                        {confirming === 'all' ? 'もう一度押すとログアウトします' : 'すべての端末からログアウト'}
                    </button>
                </section>

                <button type="button" onClick={() => window.history.back()} className="w-full text-sm text-gray-500 underline">
                    戻る
                </button>
            </div>
        </div>
    );
}
