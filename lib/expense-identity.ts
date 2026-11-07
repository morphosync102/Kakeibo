// Whether two expense objects denote the same sheet row (for optimistic edits).
// Keep free of `@/` imports: tests load it directly with Node's type stripping.

type Identifiable = {
    id?: string;
    rowId?: string;
    date: string;
    merchant: string;
    amount: number;
};

// Rows with a RowId (column H) on both sides compare by it alone, so identical
// rows from the same email stay distinct and an edited row is still found.
// Otherwise (rows not backfilled yet, or an old localStorage cache without
// rowId) fall back to the MessageId + date + merchant + amount comparison.
export function isSameExpense(a: Identifiable, b: Identifiable): boolean {
    if (a.rowId && b.rowId) return a.rowId === b.rowId;
    return a.id === b.id
        && a.date === b.date
        && a.merchant === b.merchant
        && a.amount === b.amount;
}
