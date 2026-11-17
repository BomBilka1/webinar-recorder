import test from 'node:test';
import assert from 'node:assert/strict';
import { DiskSink, duration } from '../recording-core.mjs';

test('disk writes stay in order and finish before close', async () => {
  const events = [];
  const sink = new DiskSink({
    async write(blob) {
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(await blob.text());
    },
    async close() { events.push('close'); }
  });
  sink.append(new Blob(['first']));
  sink.append(new Blob(['second']));
  await sink.close();
  assert.deepEqual(events, ['first', 'second', 'close']);
  assert.equal(sink.bytes, 11);
});

test('disk failure aborts output and cannot report success', async () => {
  let aborted = false, closed = false;
  const sink = new DiskSink({
    async write() { throw new Error('Disk full'); },
    async abort() { aborted = true; },
    async close() { closed = true; }
  });
  sink.append(new Blob(['one']));
  sink.append(new Blob(['two']));
  await assert.rejects(sink.close(), /Disk full/);
  assert.equal(aborted, true);
  assert.equal(closed, false);
  assert.equal(sink.bytes, 0);
});

test('timer handles recordings longer than one day', () => {
  assert.equal(duration(0), '00:00:00');
  assert.equal(duration(3661000), '01:01:01');
  assert.equal(duration(90061000), '25:01:01');
});
