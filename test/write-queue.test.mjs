import assert from 'node:assert/strict';
import test from 'node:test';
import { createWriteQueue, shouldApplyFetch } from '../lib/write-queue.ts';

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

test('fetch results apply only with no pending writes and no local edit since the fetch started', () => {
    assert.equal(shouldApplyFetch({ startedVersion: 3, currentVersion: 3, pendingWrites: 0 }), true);
    assert.equal(shouldApplyFetch({ startedVersion: 3, currentVersion: 4, pendingWrites: 0 }), false);
    assert.equal(shouldApplyFetch({ startedVersion: 3, currentVersion: 3, pendingWrites: 1 }), false);
    assert.equal(shouldApplyFetch({ startedVersion: 3, currentVersion: 4, pendingWrites: 2 }), false);
});
