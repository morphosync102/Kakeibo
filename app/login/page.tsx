'use client';

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(false);
    const router = useRouter();

    const performLogin = async (password: string) => {
        setIsLoading(true);
        setError(false);

        try {
            const res = await fetch("/api/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            });

            if (res.ok) {
                router.push('/');
                router.refresh();
            } else {
                setError(true);
                // Only clear input if explicitly failed, but for auto-submit loop safety,
                // we might want to keep it? No, clear is standard.
                // However, on auto-submit failure, clearing stops the loop.
                setInput("");
            }
        } catch (err) {
            setError(true);
        } finally {
            setIsLoading(false);
        }
    };

    const handleLogin = (e: FormEvent) => {
        e.preventDefault();
        performLogin(input);
    };

    // Auto-submit when input is populated (Autofill detection)
    useEffect(() => {
        if (!input) return;

        // Debounce to wait for autofill or end of typing
        // 500ms is a good balance between "snappy" and "wait for typing"
        const timer = setTimeout(() => {
            if (input.length > 3 && !isLoading) { // Assume min password length 4
                performLogin(input);
            }
        }, 800);

        return () => clearTimeout(timer);
    }, [input]);

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
                    <p className="text-gray-500 text-sm mt-1">Please enter your password</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-6">
                    <div>
                        <input
                            type="password"
                            name="password"
                            autoComplete="current-password"
                            value={input}
                            onChange={(e) => {
                                setInput(e.target.value);
                                setError(false);
                            }}
                            className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition-all text-gray-800 placeholder-gray-400"
                            placeholder="Password"
                            disabled={isLoading}
                        />
                        {error && <p className="text-red-500 text-xs mt-2 ml-1">Incorrect password</p>}
                    </div>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className={`w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-semibold shadow-lg transition-all ${isLoading ? "opacity-70 cursor-not-allowed" : "active:scale-95"
                            }`}
                    >
                        {isLoading ? "Verifying..." : "Unlock Application"}
                    </button>
                </form>
            </div>
        </div>
    );
}
