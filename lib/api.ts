export interface Expense {
  id?: string;
  date: string;
  merchant: string;
  amount: number;
  category: string;
  type?: 'Income' | 'Expense';
}

// Call our own Next.js API route (proxy) instead of GAS directly
const API_URL = '/api/expenses';

// fresh: bypass the proxy's server cache (refetch after a write or a manual
// refresh), so a list cached by a read that raced the write is not served.
export async function fetchExpenses(source?: string, { fresh = false }: { fresh?: boolean } = {}): Promise<Expense[]> {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  if (fresh) params.set('fresh', '1');
  const query = params.toString();
  const url = query ? `${API_URL}?${query}` : API_URL;
  const res = await fetch(url);
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
