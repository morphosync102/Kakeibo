'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Home, Calendar as CalendarIcon, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { Suspense } from 'react';

function BottomNavContent() {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const sourceParam = searchParams.get('source');

    const isYahoo = pathname.startsWith('/yahoo') || sourceParam === 'yahoo';

    const navItems = [
        {
            name: 'レポート',
            href: isYahoo ? '/yahoo' : '/',
            activeMatch: (p: string) => isYahoo ? p === '/yahoo' : p === '/',
            icon: Home
        },
        {
            name: 'カレンダー',
            href: isYahoo ? '/yahoo/calendar' : '/calendar',
            activeMatch: (p: string) => isYahoo ? p === '/yahoo/calendar' : p === '/calendar',
            icon: CalendarIcon
        },
        {
            name: '管理',
            href: isYahoo ? '/yahoo/manage' : '/manage',
            activeMatch: (p: string) => isYahoo ? p === '/yahoo/manage' : p === '/manage',
            icon: Settings
        },
    ];

    return (
        <div className={clsx("fixed bottom-0 left-0 right-0 border-t z-50 transition-colors pb-[calc(env(safe-area-inset-bottom)+16px)]", isYahoo ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200")}>
            <div className="flex justify-around items-center h-16">
                {navItems.map((item) => {
                    const isActive = item.activeMatch(pathname);
                    return (
                        <Link
                            key={item.name}
                            href={item.href}
                            className={clsx(
                                "flex flex-col items-center justify-center w-full h-full transition-colors",
                                isYahoo ? "active:bg-slate-800" : "active:bg-gray-50"
                            )}
                        >
                            <item.icon
                                size={24}
                                className={clsx(
                                    "mb-1 transition-colors",
                                    isActive
                                        ? (isYahoo ? "text-indigo-400" : "text-indigo-600")
                                        : (isYahoo ? "text-gray-500" : "text-gray-400")
                                )}
                            />
                            <span
                                className={clsx(
                                    "text-[10px] font-medium transition-colors",
                                    isActive
                                        ? (isYahoo ? "text-indigo-400" : "text-indigo-600")
                                        : (isYahoo ? "text-gray-500" : "text-gray-500")
                                )}
                            >
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}

export default function BottomNav() {
    return (
        <Suspense fallback={null}>
            <BottomNavContent />
        </Suspense>
    );
}
