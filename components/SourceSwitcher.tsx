'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import { sourceChoices, switchSourceHref } from '@/lib/access';
import { getSource, type SourceId } from '@/lib/sources';
import { ACCENT_CLASSES } from '@/lib/theme';

type Choice = { id: SourceId; label: string };

// One request per page load: the kakeibo the user may open, home first
// (/api/auth/session; display only, access is decided by the server).
let choicesRequest: Promise<Choice[]> | null = null;

function loadChoices(): Promise<Choice[]> {
    choicesRequest ??= fetch('/api/auth/session', { cache: 'no-store' })
        .then(async res => {
            if (!res.ok) return [];
            const data = await res.json() as { sources?: unknown };
            return Array.isArray(data.sources) ? sourceChoices(data.sources.filter((s): s is string => typeof s === 'string')) : [];
        })
        .catch(() => [])
        .then(choices => {
            if (choices.length === 0) choicesRequest = null; // retry on the next screen
            return choices;
        });
    return choicesRequest;
}

// Kakeibo switcher at the top of each view (design §4.1): shown only to users
// with two or more sources (Yuki: Yuki / 家庭用, admin: 家庭用 / 個人用). It
// keeps the tab (e.g. /yuki/calendar <-> /calendar). Colors follow the kakeibo
// being viewed.
export default function SourceSwitcher({ source }: { source: SourceId }) {
    const pathname = usePathname();
    const [choices, setChoices] = useState<Choice[]>([]);

    useEffect(() => {
        let active = true;
        loadChoices().then(next => { if (active) setChoices(next); });
        return () => { active = false; };
    }, []);

    if (choices.length < 2) return null;
    const { theme } = getSource(source);
    const accent = ACCENT_CLASSES[theme.accent];

    return (
        <nav aria-label="家計簿の切替" className="px-4 pt-3">
            <div className={clsx('flex gap-1 p-1 rounded-xl border text-sm', theme.dark ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200')}>
                {choices.map(choice => {
                    const current = choice.id === source;
                    return (
                        <Link
                            key={choice.id}
                            href={switchSourceHref(pathname, choice.id)}
                            aria-current={current ? 'page' : undefined}
                            className={clsx(
                                'flex-1 text-center rounded-lg py-2 font-semibold transition-colors',
                                current ? accent.segmentActive : theme.dark ? 'text-gray-400' : 'text-gray-500',
                            )}
                        >
                            {choice.label}
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
