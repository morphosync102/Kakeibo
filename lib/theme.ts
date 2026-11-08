// Per-accent class table (design 2026-11-yuki-and-passkeys §4.5).
// The views keep `isDarkMode` for their neutral colors and take every accent
// color (and the light page/card surfaces) from this table, so a source's
// accent is a registry setting (lib/sources.ts) instead of literals spread
// over the views.
//
// Tailwind finds class names by scanning source files for whole words, so
// every value here is a complete literal class name: never build one from
// parts (no template literal or concatenation of a color name).
// The indigo values are exactly the classes main / yahoo used before the
// registry (test/sources-theme.test.mjs pins them), so their look is unchanged.
// Keep free of `@/` imports so node --test can load it directly.

export type Accent = 'indigo' | 'pink';

// A class pair chosen by the view's dark mode
export interface ModeClasses {
    light: string;
    dark: string;
}

export interface AccentClasses {
    navActive: ModeClasses; // BottomNav: active tab icon and label
    navBar: ModeClasses; // BottomNav: bar background and top border
    segmentActive: string; // selected segment (calendar/search, statistics period)
    monthCardRing: ModeClasses; // Dashboard: ring of the focused month card
    monthCardCurrent: ModeClasses; // Dashboard: gradient of the current month's card
    dotActive: string; // Dashboard: active pagination dot
    categorySelected: ModeClasses; // Dashboard: selected category tile
    linkText: string; // text buttons ("解除")
    balancePositive: ModeClasses; // Calendar: non-negative monthly balance
    selectedDayBorder: string; // Calendar: border of the selected day
    todayText: string; // Calendar: today's date number
    todayDot: string; // Calendar: today marker
    tabActive: string; // Manage: active tab
    icon: string; // Manage: section icon
    focusRing: string; // Manage: input focus ring
    primaryButton: string; // Manage: expense submit button
    solidButton: string; // Manage: fixed-cost save button (background only)
    expenseBar: string; // Manage: expense marker in the fixed-cost list
    addButtonHover: ModeClasses; // Manage: hover of the dashed "add" button
    panelBorder: ModeClasses; // Manage: border of the fixed-cost form
    pageBg: ModeClasses; // page background (Dashboard, Manage, Statistics)
    calendarPageBg: ModeClasses; // page background (Calendar)
    card: ModeClasses; // card surface (Dashboard, Calendar, Manage)
    statsCard: ModeClasses; // card surface (Statistics)
}

export const ACCENT_CLASSES: Readonly<Record<Accent, Readonly<AccentClasses>>> = Object.freeze({
    indigo: Object.freeze({
        navActive: { light: 'text-indigo-600', dark: 'text-indigo-400' },
        navBar: { light: 'bg-white border-gray-200', dark: 'bg-slate-900 border-slate-800' },
        segmentActive: 'bg-indigo-600 text-white',
        monthCardRing: { light: 'ring-indigo-300', dark: 'ring-indigo-900' },
        monthCardCurrent: { light: 'bg-gradient-to-br from-indigo-600 to-indigo-800', dark: 'bg-gradient-to-br from-indigo-900 to-indigo-950' },
        dotActive: 'bg-indigo-500',
        categorySelected: { light: 'bg-indigo-50 border-indigo-500 ring-1 ring-indigo-500', dark: 'bg-indigo-900/30 border-indigo-500 ring-1 ring-indigo-500' },
        linkText: 'text-indigo-500',
        balancePositive: { light: 'text-indigo-600', dark: 'text-indigo-400' },
        selectedDayBorder: 'border-indigo-500',
        todayText: 'text-indigo-500',
        todayDot: 'bg-indigo-500',
        tabActive: 'bg-indigo-50 text-indigo-600',
        icon: 'text-indigo-500',
        focusRing: 'focus:ring-indigo-100',
        primaryButton: 'bg-indigo-600 hover:bg-indigo-700 text-white',
        solidButton: 'bg-indigo-600',
        expenseBar: 'bg-indigo-400',
        addButtonHover: { light: 'hover:border-indigo-200 hover:text-indigo-400', dark: 'hover:text-indigo-400 hover:border-indigo-900' },
        panelBorder: { light: 'border-indigo-100', dark: 'border-indigo-900' },
        pageBg: { light: 'bg-gray-50', dark: 'bg-slate-950' },
        calendarPageBg: { light: 'bg-white', dark: 'bg-slate-950' },
        card: { light: 'bg-white border-gray-100', dark: 'bg-slate-900 border-slate-800' },
        statsCard: { light: 'bg-white border-gray-200', dark: 'bg-slate-900 border-slate-800' },
    }),
    // Light pink (yuki). Cards stay white with pink-100 borders on a pink-50
    // page. The dark variants exist for completeness (no pink source is dark).
    pink: Object.freeze({
        navActive: { light: 'text-pink-600', dark: 'text-pink-400' },
        navBar: { light: 'bg-white border-pink-100', dark: 'bg-slate-900 border-slate-800' },
        segmentActive: 'bg-pink-500 text-white',
        monthCardRing: { light: 'ring-pink-300', dark: 'ring-pink-900' },
        monthCardCurrent: { light: 'bg-gradient-to-br from-pink-400 to-pink-600', dark: 'bg-gradient-to-br from-pink-900 to-pink-950' },
        dotActive: 'bg-pink-500',
        categorySelected: { light: 'bg-pink-50 border-pink-400 ring-1 ring-pink-400', dark: 'bg-pink-900/30 border-pink-500 ring-1 ring-pink-500' },
        linkText: 'text-pink-500',
        balancePositive: { light: 'text-pink-600', dark: 'text-pink-400' },
        selectedDayBorder: 'border-pink-400',
        todayText: 'text-pink-500',
        todayDot: 'bg-pink-500',
        tabActive: 'bg-pink-50 text-pink-600',
        icon: 'text-pink-500',
        focusRing: 'focus:ring-pink-100',
        primaryButton: 'bg-pink-500 hover:bg-pink-600 text-white',
        solidButton: 'bg-pink-500',
        expenseBar: 'bg-pink-400',
        addButtonHover: { light: 'hover:border-pink-200 hover:text-pink-400', dark: 'hover:text-pink-400 hover:border-pink-900' },
        panelBorder: { light: 'border-pink-100', dark: 'border-pink-900' },
        pageBg: { light: 'bg-pink-50', dark: 'bg-slate-950' },
        calendarPageBg: { light: 'bg-pink-50', dark: 'bg-slate-950' },
        card: { light: 'bg-white border-pink-100', dark: 'bg-slate-900 border-slate-800' },
        statsCard: { light: 'bg-white border-pink-100', dark: 'bg-slate-900 border-slate-800' },
    }),
});

export function pickMode(classes: ModeClasses, isDarkMode: boolean): string {
    return isDarkMode ? classes.dark : classes.light;
}
