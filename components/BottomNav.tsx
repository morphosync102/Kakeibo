'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, ChartNoAxesCombined, Calendar as CalendarIcon, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { getSource, sourceFromPathname, sourceHref, type SourceTab } from '@/lib/sources';
import { ACCENT_CLASSES, pickMode } from '@/lib/theme';

const NAV_ITEMS: { name: string; tab: SourceTab; icon: typeof Home }[] = [
    { name: 'レポート', tab: 'home', icon: Home },
    { name: '統計', tab: 'statistics', icon: ChartNoAxesCombined },
    { name: 'カレンダー', tab: 'calendar', icon: CalendarIcon },
    { name: '管理', tab: 'manage', icon: Settings },
];

// The tabs link inside the kakeibo of the current path (/, /yahoo/..., /yuki/...)
export default function BottomNav() {
    const pathname = usePathname();
    const source = sourceFromPathname(pathname);
    const { theme } = getSource(source);
    const isDarkMode = theme.dark;
    const accent = ACCENT_CLASSES[theme.accent];

    return (
        <div className={clsx("fixed bottom-0 left-0 right-0 border-t z-50 transition-colors pb-[calc(env(safe-area-inset-bottom)+16px)]", pickMode(accent.navBar, isDarkMode))}>
            <div className="flex justify-around items-center h-16">
                {NAV_ITEMS.map((item) => {
                    const href = sourceHref(source, item.tab);
                    const isActive = pathname === href;
                    return (
                        <Link
                            key={item.name}
                            href={href}
                            aria-current={isActive ? 'page' : undefined}
                            className={clsx(
                                "flex flex-col items-center justify-center w-full h-full transition-colors",
                                isDarkMode ? "active:bg-slate-800" : "active:bg-gray-50"
                            )}
                        >
                            <item.icon
                                size={24}
                                className={clsx(
                                    "mb-1 transition-colors",
                                    isActive
                                        ? pickMode(accent.navActive, isDarkMode)
                                        : (isDarkMode ? "text-gray-500" : "text-gray-400")
                                )}
                            />
                            <span
                                className={clsx(
                                    "text-[10px] font-medium transition-colors",
                                    isActive
                                        ? pickMode(accent.navActive, isDarkMode)
                                        : "text-gray-500"
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
