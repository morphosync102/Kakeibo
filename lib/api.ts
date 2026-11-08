import type { SourceId } from './sources';
import { handleSessionExpired } from './client-session.ts';

export interface Expense {
  id?: string; // MessageId (shared by rows from the same email)
  rowId?: string; // RowId (column H): unique per row; absent until backfilled
  date: string;
  merchant: string;
  amount: number;
  category: string;
  type?: 'Income' | 'Expense';
}

// Call our own Next.js API route (proxy) instead of GAS directly
const API_URL = '/api/expenses';

// source is required and always sent (main included): no fallback to main.
// fresh: bypass the proxy's server cache (refetch after a write or a manual
// refresh), so a list cached by a read that raced the write is not served.
export async function fetchExpenses(source: SourceId, { fresh = false }: { fresh?: boolean } = {}): Promise<Expense[]> {
  const params = new URLSearchParams({ source });
  if (fresh) params.set('fresh', '1');
  const res = await fetch(`${API_URL}?${params.toString()}`);
  // Invalid, expired or revoked session: clear the cached lists, go to /login
  if (res.status === 401) handleSessionExpired();
  if (!res.ok) {
    throw new Error(`Failed to fetch data (${res.status})`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(data?.error || 'Unexpected response');
  }

  // Sort by date desc
  return data.sort((a: Expense, b: Expense) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
