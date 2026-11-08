import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
    ceremonyFailureMessage, ceremonyErrorMessage, createAutoStartGate, isFresh, isLoggedOutLanding, shouldAutoStartPasskey,
} from '../lib/passkey-client.ts';

// /login starts the passkey (Face ID) by itself once, when allowed; failures
// and cancels fall back quietly to the button.

const ready = { optionsReady: true, supported: true, inAppBrowser: false, loggedOut: false, typingPassword: false };
const params = query => new URLSearchParams(query);

test('auto start only when the challenge is ready, WebAuthn works, not right after a logout, not in-app, not typing a password', () => {
    assert.equal(shouldAutoStartPasskey(ready), true);
    for (const [label, change] of [
        ['challenge not fetched yet', { optionsReady: false }],
        ['WebAuthn not supported', { supported: false }],
        ['in-app browser (LINE etc.)', { inAppBrowser: true }],
        ['explicit logout just before', { loggedOut: true }],
        ['typing the password', { typingPassword: true }],
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

test('LoginForm wires it: one gated auto attempt after the challenge, quiet fallback, same success path as the button', () => {
    const form = fs.readFileSync(new URL('../app/login/LoginForm.tsx', import.meta.url), 'utf8');
    assert.match(form, /createAutoStartGate\(\)/);
    assert.match(form, /shouldAutoStartPasskey\(\{/);
    assert.match(form, /isLoggedOutLanding\(searchParams\)/);
    assert.match(form, /isInAppBrowser\(navigator\.userAgent\)/);
    assert.match(form, /typingPassword: input\.length > 0/);
    assert.match(form, /ceremonyFailureMessage\(e, \{ auto \}\)/);
    assert.match(form, /loginWithPasskey\(\{ auto: true \}\)/);
    assert.match(form, /loginWithPasskey\(\{ auto: false \}\)/);
    assert.match(form, /顔認証でログイン/);
    // both paths end in finishLogin (cache housekeeping + server-validated redirect)
    assert.match(form, /finishLogin\(result\.data\)/);
    assert.match(form, /rememberLoginUser\(browserStorage\(\), data\.userId\)/);
    assert.match(form, /window\.location\.assign\(safeRedirect\(data\.redirectTo\)\)/);
    // no Conditional UI in this version
    assert.doesNotMatch(form, /useBrowserAutofill|mediation/);
});
