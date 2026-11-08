import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    INVITE_COPY_TO_SAFARI_HINT, INVITE_IN_APP_BROWSER_NOTICE, INVITE_MISSING_TOKEN_MESSAGE, shouldClearInviteFragment,
    ceremonyFailureMessage, ceremonyErrorMessage, createAutoStartGate, isFresh, isLockedLanding, isLoggedOutLanding, LOCKED_NOTICE,
    shouldAutoStartPasskey,
} from '../lib/passkey-client.ts';

// /login starts the passkey (Face ID) by itself once, when allowed; failures
// and cancels fall back quietly to the button.

const ready = { optionsReady: true, supported: true, inAppBrowser: false, loggedOut: false };
const params = query => new URLSearchParams(query);

test('auto start only when the challenge is ready, WebAuthn works, not right after a logout, not in-app', () => {
    assert.equal(shouldAutoStartPasskey(ready), true);
    for (const [label, change] of [
        ['challenge not fetched yet', { optionsReady: false }],
        ['WebAuthn not supported', { supported: false }],
        ['in-app browser (LINE etc.)', { inAppBrowser: true }],
        ['explicit logout just before', { loggedOut: true }],
    ]) {
        assert.equal(shouldAutoStartPasskey({ ...ready, ...change }), false, label);
    }
});

test('loggedOut=1 marks the landing after a logout; reason=session (expired / revoked) still auto-starts', () => {
    assert.equal(isLoggedOutLanding(params('loggedOut=1')), true);
    assert.equal(isLoggedOutLanding(params('loggedOut=1&returnTo=%2Fyuki')), true);
    for (const query of ['', 'reason=session', 'reason=session&returnTo=%2F', 'loggedOut=0', 'loggedOut=', 'loggedout=1']) {
        assert.equal(isLoggedOutLanding(params(query)), false, query);
    }
    assert.equal(shouldAutoStartPasskey({ ...ready, loggedOut: isLoggedOutLanding(params('reason=session')) }), true);
});

test('the app lock screen (reason=locked) is recognized, explained and starts Face ID by itself', () => {
    assert.equal(isLockedLanding(params('returnTo=%2Fyuki&reason=locked')), true);
    for (const query of ['', 'reason=session', 'loggedOut=1', 'reason=Locked']) assert.equal(isLockedLanding(params(query)), false, query);
    assert.equal(shouldAutoStartPasskey({ ...ready, loggedOut: isLoggedOutLanding(params('returnTo=%2Fyuki&reason=locked')) }), true);
    assert.match(LOCKED_NOTICE, /ロック/);
});

test('the automatic attempt happens at most once per page, even after a failure', () => {
    const gate = createAutoStartGate();
    assert.equal(gate.tryStart(false), false, 'conditions not met: no attempt, and the chance is kept');
    assert.equal(gate.tryStart(true), true, 'first time conditions are met');
    assert.equal(gate.tryStart(true), false, 'never again (no loop after a cancel or a rejection)');
    assert.equal(gate.tryStart(true), false);
    assert.equal(gate.started, true);
});

test('a failed automatic attempt is silent; a tapped attempt explains the failure', () => {
    for (const name of ['NotAllowedError', 'AbortError', 'SecurityError', 'InvalidStateError', 'UnknownError']) {
        const error = Object.assign(new Error('detail'), { name });
        assert.equal(ceremonyFailureMessage(error, { auto: true }), null, name);
        assert.equal(ceremonyFailureMessage(error, { auto: false }), ceremonyErrorMessage(error), name);
    }
});

test('the auto start reuses the prefetched challenge only while fresh (the 4-minute rule)', () => {
    const t = 1_800_000_000_000;
    assert.equal(isFresh(t, t + 1000), true);
    assert.equal(isFresh(t, t + 4 * 60 * 1000), false);
});

const LINE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.0.0';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('invite: the token fragment is kept in in-app browsers (handed to Safari) and removed in normal browsers', () => {
    assert.equal(shouldClearInviteFragment(LINE_UA), false);
    assert.equal(shouldClearInviteFragment('Mozilla/5.0 (iPhone) AppleWebKit Instagram 300.0'), false);
    assert.equal(shouldClearInviteFragment(SAFARI_UA), true);
    assert.equal(shouldClearInviteFragment(''), true);
});

test('invite: the in-app notice and the missing-token error tell how to copy the link into Safari', () => {
    assert.match(INVITE_COPY_TO_SAFARI_HINT, /長押しでコピー/);
    assert.match(INVITE_COPY_TO_SAFARI_HINT, /Safari のアドレス欄に貼り付け/);
    assert.match(INVITE_COPY_TO_SAFARI_HINT, /iMessage/);
    assert.ok(INVITE_IN_APP_BROWSER_NOTICE.includes('Safariで開く'));
    assert.ok(INVITE_IN_APP_BROWSER_NOTICE.includes(INVITE_COPY_TO_SAFARI_HINT));
    assert.ok(INVITE_MISSING_TOKEN_MESSAGE.includes('招待リンクが正しくありません'));
    assert.ok(INVITE_MISSING_TOKEN_MESSAGE.includes(INVITE_COPY_TO_SAFARI_HINT));
});

test('LoginForm wires it: one gated auto attempt after the challenge, quiet fallback, same success path as the button', () => {
    const form = fs.readFileSync(new URL('../app/login/LoginForm.tsx', import.meta.url), 'utf8');
    assert.match(form, /createAutoStartGate\(\)/);
    assert.match(form, /shouldAutoStartPasskey\(\{/);
    assert.match(form, /isLoggedOutLanding\(searchParams\)/);
    assert.match(form, /isInAppBrowser\(navigator\.userAgent\)/);
    assert.doesNotMatch(form, /typingPassword/);
    assert.match(form, /\{locked && <p[^>]*>\{LOCKED_NOTICE\}<\/p>\}/);
    assert.match(form, /ceremonyFailureMessage\(e, \{ auto \}\)/);
    assert.match(form, /loginWithPasskey\(\{ auto: true \}\)/);
    assert.match(form, /loginWithPasskey\(\{ auto: false \}\)/);
    assert.match(form, /顔認証でログイン/);
    // both paths end in finishLogin (cache housekeeping + server-validated redirect)
    assert.match(form, /finishLogin\(result\.data\)/);
    assert.match(form, /const storage = browserStorage\(\);\s*if \(typeof data\.userId === 'string'\) rememberLoginUser\(storage, data\.userId\);/);
    assert.match(form, /window\.location\.assign\(safeRedirect\(data\.redirectTo\)\)/);
    // no Conditional UI in this version
    assert.doesNotMatch(form, /useBrowserAutofill|mediation/);
});
