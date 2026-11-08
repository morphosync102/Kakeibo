'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { handleUnauthorized } from "@/lib/client-session";
import { apiErrorMessage, isSessionFailure, postAuthJson, type ApiResult } from "@/lib/passkey-client";

// LINE linking of the signed-in user's own kakeibo (design §5.4, U5; only
// users with a lineOptional source, i.e. Yuki): issue a one-time code, send
// it to the official LINE account, check the LINE display name shown here is
// your own, then confirm (or cancel). Until confirmed nothing is set.

type Phase = 'loading' | 'none' | 'code' | 'pending' | 'candidate' | 'linked' | 'cancelled' | 'unavailable';

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS = 11 * 60 * 1000;

export default function LineLinkPage() {
    const [phase, setPhase] = useState<Phase>('loading');
    const [code, setCode] = useState<string | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);

    const handleFailure = useCallback((result: ApiResult) => {
        if (isSessionFailure(result)) {
            handleUnauthorized(result.data.error);
            return;
        }
        if (result.status === 403) setPhase('unavailable');
        setError(apiErrorMessage(result));
    }, []);

    const refresh = useCallback(async (): Promise<string | null> => {
        const result = await postAuthJson('/api/auth/line-link/status');
        if (!result.ok) {
            handleFailure(result);
            return null;
        }
        const status = typeof result.data.status === 'string' ? result.data.status : 'none';
        if (status === 'candidate' && typeof result.data.displayName === 'string') {
            setDisplayName(result.data.displayName);
            setPhase('candidate');
        } else if (status === 'pending') {
            // The code is shown only right after it was issued
            setPhase(current => (current === 'code' ? 'code' : 'pending'));
        } else {
            setPhase(current => (current === 'linked' || current === 'cancelled' ? current : 'none'));
        }
        return status;
    }, [handleFailure]);

    const stopPolling = useCallback(() => {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
    }, []);

    // While a code is waiting, poll for the candidate (the LINE message);
    // the code lives 10 minutes, so polling stops after that
    const poll = useCallback(() => {
        stopPolling();
        const startedAt = Date.now();
        timer.current = setInterval(async () => {
            const status = await refresh();
            if (status !== 'pending' || Date.now() - startedAt > POLL_MAX_MS) stopPolling();
        }, POLL_INTERVAL_MS);
    }, [refresh, stopPolling]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the fetch resolves, not synchronously
        void refresh().then(status => { if (status === 'pending') poll(); });
        return stopPolling;
    }, [refresh, poll, stopPolling]);

    const issue = async () => {
        setBusy(true);
        setError(null);
        const result = await postAuthJson('/api/auth/line-link/code');
        setBusy(false);
        if (!result.ok) return handleFailure(result);
        setCode(typeof result.data.code === 'string' ? result.data.code : null);
        setPhase('code');
        poll();
    };

    const decide = async (decision: 'confirm' | 'cancel') => {
        setBusy(true);
        setError(null);
        const result = await postAuthJson('/api/auth/line-link/confirm', { decision });
        setBusy(false);
        if (!result.ok) {
            handleFailure(result);
            void refresh();
            return;
        }
        setCode(null);
        setDisplayName('');
        setPhase(decision === 'confirm' ? 'linked' : 'cancelled');
    };

    const buttonClass = "w-full bg-pink-500 hover:bg-pink-600 text-white py-3 rounded-xl font-semibold shadow transition-all active:scale-95 disabled:opacity-70";

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-pink-50 p-4">
            <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-sm space-y-4">
                <h1 className="text-xl font-bold text-gray-800 text-center">LINE 連携</h1>
                <p className="text-gray-600 text-sm">月次レポートを受け取る LINE を設定します。</p>

                {phase === 'loading' && <p className="text-gray-500 text-sm text-center">確認しています...</p>}
                {phase === 'unavailable' && <p className="text-gray-600 text-sm">この家計簿では LINE 連携は使えません。</p>}

                {(phase === 'none' || phase === 'pending' || phase === 'cancelled' || phase === 'linked') && (
                    <>
                        {phase === 'linked' && <p className="text-gray-700 text-sm font-semibold">連携しました。LINE に確認のメッセージが届きます。</p>}
                        {phase === 'cancelled' && <p className="text-gray-700 text-sm">取り消しました。</p>}
                        {phase === 'pending' && <p className="text-gray-600 text-sm">発行済みのコードは再表示できません。新しいコードを発行してください。</p>}
                        <button type="button" disabled={busy} onClick={() => { void issue(); }} className={buttonClass}>
                            {phase === 'linked' ? '別の LINE に連携し直す' : '連携コードを発行'}
                        </button>
                    </>
                )}

                {phase === 'code' && code && (
                    <>
                        <p className="text-gray-600 text-sm">家計簿の LINE 公式アカウントを友だち追加して、次のコードをトークで送ってください(10分間有効)。</p>
                        <p className="text-center text-2xl font-mono tracking-widest text-gray-800 bg-gray-50 rounded-lg py-3 select-all">{code}</p>
                        <p className="text-gray-500 text-xs">送ると、この画面に LINE の名前が表示されます。</p>
                        <button type="button" disabled={busy} onClick={() => { void refresh(); }} className="w-full text-sm text-gray-500 underline">
                            送信したので確認する
                        </button>
                    </>
                )}

                {phase === 'candidate' && (
                    <>
                        <p className="text-gray-700 text-sm">次の LINE から送られました。あなたの LINE ですか?</p>
                        <p className="text-center text-lg font-semibold text-gray-800 bg-gray-50 rounded-lg py-3 break-all">{displayName}</p>
                        <button type="button" disabled={busy} onClick={() => { void decide('confirm'); }} className={buttonClass}>
                            はい、この LINE に連携する
                        </button>
                        <button type="button" disabled={busy} onClick={() => { void decide('cancel'); }} className="w-full text-sm text-gray-600 underline">
                            いいえ(取り消す)
                        </button>
                    </>
                )}

                {error && <p className="text-red-500 text-sm" role="alert">{error}</p>}

                <button type="button" onClick={() => window.history.back()} className="w-full text-sm text-gray-500 underline">
                    戻る
                </button>
            </div>
        </div>
    );
}
