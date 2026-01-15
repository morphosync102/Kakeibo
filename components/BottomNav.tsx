'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Calendar as CalendarIcon, Wallet, Settings } from 'lucide-react';
import { clsx } from 'clsx';

export default function BottomNav() {
    const pathname = usePathname();

    const navItems = [
        { name: 'レポート', href: '/', icon: Home },
        { name: 'カレンダー', href: '/calendar', icon: CalendarIcon },
        { name: '管理', href: '/manage', icon: Settings },
    ];

    return (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 pb-safe-area-bottom z-50">
            <div className="flex justify-around items-center h-16">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.name}
                            href={item.href}
                            className="flex flex-col items-center justify-center w-full h-full active:bg-gray-50 transition-colors"
                        >
                            <item.icon
                                size={24}
                                className={clsx(
                                    "mb-1 transition-colors",
                                    isActive ? "text-indigo-600" : "text-gray-400"
                                )}
                            />
                            <span
                                className={clsx(
                                    "text-[10px] font-medium transition-colors",
                                    isActive ? "text-indigo-600" : "text-gray-500"
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
