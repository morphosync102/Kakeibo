// Server-side only. LINE webhook (design 2026-11-yuki-and-passkeys §5.4):
// the signature (X-Line-Signature = base64 HMAC-SHA256 of the raw body with
// LINE_CHANNEL_SECRET) is checked on the raw text BEFORE JSON.parse, then
// only text messages shaped like a link code are forwarded to GAS
// authLinkLine (with authKey). The code, the LINE userId, the body and the
// signature are never logged.
// Keep free of `@/` imports so node --test can load it directly.

import { constantTimeEqual } from './session.ts';
import { callGasAuth, type GasAuthEnv } from './gas-auth.ts';

export const LINE_SIGNATURE_HEADER = 'x-line-signature';
export const MAX_WEBHOOK_BODY_LENGTH = 256 * 1024;
export const MAX_FORWARDED_PER_WEBHOOK = 5;
// Same as GAS: 10 characters of the 32 unambiguous symbols (no 0 O 1 I l)
export const LINK_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{10}$/;
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
const REPLY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
export const LINK_ACCEPTED_REPLY = 'コードを受け付けました。家計簿アプリの「LINE 連携」画面で、表示される名前を確認して確定してください。';

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export async function lineSignature(channelSecret: string, rawBody: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))));
}

// Constant-time comparison of the expected and the received signature
export async function isValidLineSignature(channelSecret: string, rawBody: string, signature: string | null): Promise<boolean> {
    if (!channelSecret || typeof signature !== 'string' || signature.length === 0 || signature.length > 128) return false;
    return constantTimeEqual(await lineSignature(channelSecret, rawBody), signature);
}

export interface LinkCodeMessage {
    code: string;
    lineUserId: string;
    replyToken: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Text messages from a user (1:1 chat) whose whole text is a link code
// (trimmed, case-insensitive). Redeliveries and standby events are skipped
// (the first delivery was handled; a second match would count as a failure).
export function linkCodeMessages(payload: unknown): LinkCodeMessage[] {
    if (!isRecord(payload) || !Array.isArray(payload.events)) return [];
    const found: LinkCodeMessage[] = [];
    for (const event of payload.events) {
        if (!isRecord(event) || event.type !== 'message' || !isRecord(event.message) || !isRecord(event.source)) continue;
        if (event.message.type !== 'text' || typeof event.message.text !== 'string' || event.message.text.length > 64) continue;
        if (event.source.type !== 'user' || typeof event.source.userId !== 'string' || !LINE_USER_ID_PATTERN.test(event.source.userId)) continue;
        if (event.mode !== undefined && event.mode !== 'active') continue;
        if (isRecord(event.deliveryContext) && event.deliveryContext.isRedelivery === true) continue;
        const code = event.message.text.trim().toUpperCase();
        if (!LINK_CODE_PATTERN.test(code)) continue;
        const replyToken = typeof event.replyToken === 'string' && REPLY_TOKEN_PATTERN.test(event.replyToken) ? event.replyToken : null;
        found.push({ code, lineUserId: event.source.userId, replyToken });
        if (found.length >= MAX_FORWARDED_PER_WEBHOOK) break;
    }
    return found;
}

export interface LineWebhookEnv extends GasAuthEnv {
    LINE_CHANNEL_ACCESS_TOKEN?: string;
}

type Logger = Pick<Console, 'warn' | 'error' | 'log'>;

// Forwards each code to GAS authLinkLine (one at a time). On a match, and
// only if LINE_CHANNEL_ACCESS_TOKEN is set on this side, replies "confirm in
// the app" (design §5.4: reply on success only). Never throws.
export async function forwardLinkCodes(messages: readonly LinkCodeMessage[], { env, fetchImpl, log = console }: { env: LineWebhookEnv; fetchImpl: typeof fetch; log?: Logger }): Promise<void> {
    for (const message of messages) {
        const result = await callGasAuth('authLinkLine', { code: message.code, lineUserId: message.lineUserId }, { env, fetchImpl });
        if (!result.ok) {
            // LinkCodeInvalid / RateLimited are expected; log the code word only
            log.warn(`LINE webhook: authLinkLine ${result.error}`);
            continue;
        }
        log.log('LINE webhook: a link code matched; waiting for the user\'s confirmation');
        const token = env.LINE_CHANNEL_ACCESS_TOKEN;
        if (!token || !message.replyToken) continue;
        try {
            const res = await fetchImpl('https://api.line.me/v2/bot/message/reply', {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ replyToken: message.replyToken, messages: [{ type: 'text', text: LINK_ACCEPTED_REPLY }] }),
            });
            if (!res.ok) log.warn(`LINE webhook: reply failed (${res.status})`);
        } catch {
            log.warn('LINE webhook: reply failed');
        }
    }
}
