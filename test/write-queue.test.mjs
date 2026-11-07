import assert from 'node:assert/strict';
import test from 'node:test';
import { createWriteQueue, fetchDiscardAction, isWriteTimeout, postWrite, shouldApplyFetch, WRITE_TIMEOUT_MS } from '../lib/write-queue.ts';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('writes run one at a time: the second starts only after the first settles', async () => {
    const queue = createWriteQueue();
    const first = deferred();
    const started = [];
    const a = queue.enqueue(() => { started.push('a'); return first.promise; });
    const b = queue.enqueue(async () => { started.push('b'); return 'b-done'; });
    await tick();
    assert.deepEqual(started, ['a']);
    assert.equal(queue.pending(), 2);
    first.resolve('a-done');
    assert.equal(await a, 'a-done');
    assert.equal(await b, 'b-done');
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(queue.pending(), 0);
});

test('a failed write still lets the next one run, and the caller sees the failure', async () => {
    const queue = createWriteQueue();
    const started = [];
    const a = queue.enqueue(async () => { started.push('a'); throw new Error('boom'); });
    const b = queue.enqueue(async () => { started.push('b'); return 'ok'; });
    await assert.rejects(a, /boom/);
    assert.equal(await b, 'ok');
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(queue.pending(), 0);
});

test('a write that throws synchronously does not break the chain', async () => {
    const queue = createWriteQueue();
    const a = queue.enqueue(() => { throw new Error('sync'); });
    const b = queue.enqueue(async () => 'next');
    await assert.rejects(a, /sync/);
    assert.equal(await b, 'next');
});

test('pending count is published to subscribers and already decremented when the caller resumes', async () => {
    const queue = createWriteQueue();
    const seen = [];
    const unsubscribe = queue.subscribe(count => seen.push(count));
    const gate = deferred();
    const a = queue.enqueue(() => gate.promise);
    const b = queue.enqueue(async () => {});
    assert.deepEqual(seen, [1, 2]);
    gate.resolve();
    await a;
    assert.equal(queue.pending(), 1, 'the first write is no longer pending when its caller continues');
    await b;
    assert.equal(queue.pending(), 0);
    assert.deepEqual(seen, [1, 2, 1, 0]);
    unsubscribe();
    await queue.enqueue(async () => {});
    assert.deepEqual(seen, [1, 2, 1, 0], 'unsubscribed listeners are not called');
});

test('settled count advances once per finished write, success or failure', async () => {
    const queue = createWriteQueue();
    assert.equal(queue.settled(), 0);
    const gate = deferred();
    const a = queue.enqueue(() => gate.promise);
    assert.equal(queue.settled(), 0, 'not settled while in flight');
    gate.resolve();
    await a;
    assert.equal(queue.settled(), 1);
    await assert.rejects(queue.enqueue(async () => { throw new Error('x'); }));
    assert.equal(queue.settled(), 2);
});

const base = { startedVersion: 3, currentVersion: 3, pendingAtStart: 0, pendingWrites: 0, settledAtStart: 5, settledWrites: 5 };

test('fetch results apply only if no write was pending or finished and no local edit happened during the fetch', () => {
    assert.equal(shouldApplyFetch(base), true);
    assert.equal(shouldApplyFetch({ ...base, currentVersion: 4 }), false, 'local edit during the fetch');
    assert.equal(shouldApplyFetch({ ...base, pendingWrites: 1 }), false, 'write still pending');
    assert.equal(shouldApplyFetch({ ...base, pendingAtStart: 1 }), false, 'started while a write was in flight (may predate it)');
    assert.equal(shouldApplyFetch({ ...base, settledWrites: 6 }), false, 'a write finished while the fetch was in flight');
    // Round-1 Low1: Y started during a write, Z after it; Y returning last must not win
    assert.equal(shouldApplyFetch({ ...base, pendingAtStart: 1, settledAtStart: 5, settledWrites: 6 }), false);
});

test('a discarded fetch waits for the queue, reloads, or defers to a newer fetch', () => {
    assert.equal(fetchDiscardAction({ pendingWrites: 2, newerFetchStarted: false }), 'reload-after-writes');
    assert.equal(fetchDiscardAction({ pendingWrites: 1, newerFetchStarted: true }), 'reload-after-writes');
    assert.equal(fetchDiscardAction({ pendingWrites: 0, newerFetchStarted: false }), 'reload-now');
    assert.equal(fetchDiscardAction({ pendingWrites: 0, newerFetchStarted: true }), 'none');
});

test('postWrite sends a keepalive POST with a timeout signal and rejects on a GAS error', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        return { json: async () => (JSON.parse(init.body).action === 'bad' ? { error: 'Busy' } : { success: true }) };
    });
    assert.deepEqual(await postWrite({ action: 'ok' }), { success: true });
    assert.equal(calls[0].url, '/api/expenses');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.keepalive, true);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    const failure = await postWrite({ action: 'bad' }).then(() => null, e => e);
    assert.match(failure.message, /Busy/);
    assert.equal(isWriteTimeout(failure), false, 'a GAS error is a definite failure');
    assert.equal(isWriteTimeout(new Error('x')), false);
    assert.equal(isWriteTimeout(undefined), false);
    assert.ok(WRITE_TIMEOUT_MS >= 30000, 'must outlast the GAS lock wait (20s) plus processing');
});

test('a write that times out fails and the next queued write still runs', async (t) => {
    t.mock.method(globalThis, 'fetch', (url, init) => {
        if (JSON.parse(init.body).action === 'hang') {
            return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        }
        return Promise.resolve({ json: async () => ({ success: true }) });
    });
    const hung = postWrite({ action: 'hang' }, { timeoutMs: 20 });
    const next = postWrite({ action: 'next' });
    const error = await hung.then(() => null, e => e);
    assert.match(error.message, /タイムアウト/);
    assert.equal(isWriteTimeout(error), true, 'a timeout is distinguishable: the write may still have landed');
    assert.deepEqual(await next, { success: true });
});
