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

export async function fetchExpenses(source?: string): Promise<Expense[]> {
  try {
    const url = source ? `${API_URL}?source=${source}` : API_URL;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error('Failed to fetch data');
    }
    const data = await res.json();

    // Sort by date desc
    return data.sort((a: Expense, b: Expense) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch (error) {
    console.error('API Error:', error);
    return [];
  }
}
