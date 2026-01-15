import { NextResponse } from 'next/server';

// This URL will be updated with the user's new deployment URL
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzDGfsMyS12zFIjE2htjJkjV2tiPEFgjxvurWzfOO2ZbWG5-Un_TDNcYiqJDaOJkxw9/exec';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const query = searchParams.toString();
        const url = query ? `${GAS_API_URL}?${query}` : GAS_API_URL;

        const res = await fetch(url, {
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const res = await fetch(GAS_API_URL, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) throw new Error('Failed to post to GAS');
        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json({ error: 'Post Error' }, { status: 500 });
    }
}
