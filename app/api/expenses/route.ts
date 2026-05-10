import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

// This URL will be updated with the user's new deployment URL
const GAS_API_URL = process.env.GAS_API_URL || '';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const query = searchParams.toString();
        const url = query ? `${GAS_API_URL}?${query}` : GAS_API_URL;

        const res = await fetch(url, {
            // Cache for 1 hour (3600 seconds)
            next: {
                revalidate: 3600,
                tags: ['expenses']
            },
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        return NextResponse.json(data);
    } catch {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const res = await fetch(GAS_API_URL, {
            method: 'POST',
            cache: 'no-store', // POST requests should not be cached
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) throw new Error('Failed to post to GAS');
        const data = await res.json();

        // Invalidate cache on successful update
        revalidateTag('expenses', 'max');

        return NextResponse.json(data);
    } catch {
        return NextResponse.json({ error: 'Post Error' }, { status: 500 });
    }
}
