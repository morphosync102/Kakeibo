import { NextResponse, after } from 'next/server';
import { forwardLinkCodes, isValidLineSignature, LINE_SIGNATURE_HEADER, linkCodeMessages, MAX_WEBHOOK_BODY_LENGTH } from '@/lib/line-webhook';

// LINE Messaging API webhook (design §5.4). Public path: the signature is the
// authentication. The raw text is verified first (request.text(), never a
// re-serialized JSON); an invalid or missing signature is 401 and nothing is
// parsed or logged. A signed request is always answered 200 at once, and
// link codes are forwarded to GAS after the response (after()), so LINE never
// retries because GAS is slow.

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
    const env = process.env;
    const channelSecret = env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
        console.error('LINE webhook is not configured (LINE_CHANNEL_SECRET).');
        return NextResponse.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
    }
    let rawBody: string;
    try {
        rawBody = await request.text();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }
    if (rawBody.length > MAX_WEBHOOK_BODY_LENGTH
        || !await isValidLineSignature(channelSecret, rawBody, request.headers.get(LINE_SIGNATURE_HEADER))) {
        console.warn('LINE webhook: invalid signature (ignored).');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }

    let payload: unknown = null;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        payload = null; // signed but unreadable: nothing to do
    }
    const messages = linkCodeMessages(payload);
    if (messages.length > 0) {
        after(() => forwardLinkCodes(messages, { env, fetchImpl: fetch, log: console }));
    }
    return NextResponse.json({}, { headers: NO_STORE });
}
