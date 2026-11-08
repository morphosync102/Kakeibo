import { NextResponse } from 'next/server';

// The shared-password login of the migration period was removed (design
// §3.10, §11 U6). The path stays public and always answers 404, so a stale
// login page still open somewhere shows "password login has ended" instead of
// "wrong password". Nothing is read from the request, no session is issued
// and GAS is never called. Recovery is by invite only (GAS editor functions
// createAdminRecoveryInvite / createYukiRecoveryInvite).

const NOT_FOUND = () => NextResponse.json({ error: 'Not Found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function POST() {
    return NOT_FOUND();
}

export async function GET() {
    return NOT_FOUND();
}
