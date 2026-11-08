// Source registry of the UI (design 2026-11-yuki-and-passkeys §2.2).
// One entry per kakeibo; it mirrors SOURCES in gas/コード.js (ids, order and
// labels are checked by test/sources-theme.test.mjs). Routes, titles and the
// theme of every view come from here, so a view never special-cases a source.
// Keep free of `@/` imports and runtime imports so node --test can load it.

import type { Accent } from './theme';

export type SourceId = 'main' | 'yahoo' | 'yuki';
export type SourceTab = 'home' | 'statistics' | 'calendar' | 'manage';

export interface SourceTheme {
    dark: boolean; // dark neutral colors (isDarkMode of the views)
    accent: Accent; // accent class table (lib/theme.ts)
    background: string; // body background (layout)
    themeColor: string; // browser / iOS status bar color
}

export interface SourceDefinition {
    id: SourceId;
    label: string; // same as the GAS registry label
    basePath: string; // route prefix ('' for main: /, /statistics, ...)
    dashboardTitle: string;
    manageTitle: string;
    theme: SourceTheme;
    // Its LINE monthly-report destination is set by the user's own LINE
    // linking (same as GAS SOURCES lineOptional; checked by a test)
    lineOptional: boolean;
}

export const SOURCES: Readonly<Record<SourceId, Readonly<SourceDefinition>>> = Object.freeze({
    main: Object.freeze({
        id: 'main',
        label: '家庭用',
        basePath: '',
        dashboardTitle: 'My kakeibo',
        manageTitle: '管理・入力',
        theme: Object.freeze({ dark: false, accent: 'indigo', background: '#ffffff', themeColor: '#ffffff' }),
        lineOptional: false,
    }),
    yahoo: Object.freeze({
        id: 'yahoo',
        label: '個人用',
        basePath: '/yahoo',
        dashboardTitle: '個人kakeibo',
        manageTitle: '個人kakeibo管理',
        theme: Object.freeze({ dark: true, accent: 'indigo', background: '#020617', themeColor: '#020617' }),
        lineOptional: false,
    }),
    yuki: Object.freeze({
        id: 'yuki',
        label: 'Yuki',
        basePath: '/yuki',
        dashboardTitle: 'Yuki kakeibo',
        manageTitle: 'Yuki kakeibo管理',
        theme: Object.freeze({ dark: false, accent: 'pink', background: '#fdf2f8', themeColor: '#fdf2f8' }),
        lineOptional: true,
    }),
} as Record<SourceId, SourceDefinition>);

export const SOURCE_IDS: readonly SourceId[] = Object.freeze(Object.keys(SOURCES) as SourceId[]);

// The user's sources whose LINE destination the user may link (yuki)
export function lineLinkableSources(sources: readonly string[]): SourceId[] {
    return sources.filter((id): id is SourceId => isSourceId(id) && SOURCES[id].lineOptional);
}

export function isSourceId(value: unknown): value is SourceId {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOURCES, value);
}

// The registry entry of an exact id. No default: anything else throws.
export function getSource(id: SourceId): Readonly<SourceDefinition> {
    if (!isSourceId(id)) throw new Error(`Unknown source: ${String(id)}`);
    return SOURCES[id];
}

// Which kakeibo a page path belongs to (for navigation only; data requests
// always name their source explicitly). Paths outside /yahoo and /yuki are main.
export function sourceFromPathname(pathname: string): SourceId {
    for (const id of SOURCE_IDS) {
        const base = SOURCES[id].basePath;
        if (base && (pathname === base || pathname.startsWith(`${base}/`))) return id;
    }
    return 'main';
}

const TAB_PATHS: Readonly<Record<SourceTab, string>> = Object.freeze({
    home: '',
    statistics: '/statistics',
    calendar: '/calendar',
    manage: '/manage',
});

export function sourceHref(id: SourceId, tab: SourceTab): string {
    return `${getSource(id).basePath}${TAB_PATHS[tab]}` || '/';
}

// The tab of a page path (e.g. '/yuki/calendar' -> 'calendar'); 'home' for
// anything else. Used to keep the tab when switching kakeibo.
export function tabFromPathname(pathname: string): SourceTab {
    const rest = pathname.slice(getSource(sourceFromPathname(pathname)).basePath.length);
    for (const tab of Object.keys(TAB_PATHS) as SourceTab[]) {
        if (tab !== 'home' && (rest === TAB_PATHS[tab] || rest.startsWith(`${TAB_PATHS[tab]}/`))) return tab;
    }
    return 'home';
}
