// Pure helpers for the /api/expenses proxy (app/api/expenses/route.ts).
// Keep free of `@/` and Next imports so node --test can load it directly.

// An omitted source (missing query param / body field) means 'main'. Anything
// else, including '' and case variants such as 'Yahoo', is rejected so a bug
// can never route personal data into the household sheets.
export function isAllowedSource(source: unknown): boolean {
    return source === undefined || source === null || source === 'main' || source === 'yahoo';
}

// GAS answers both list endpoints (expenses and getFixedCosts) with a JSON
// array, and reports failures as a 200 `{ error }` object. Only an array may be
// returned (and therefore cached); everything else throws.
export function parseGasList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    const message = data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : 'Unexpected response from GAS';
    throw new Error(message);
}
