import assert from 'node:assert/strict';
import test from 'node:test';
import { deferTerminalConnection } from '../../../src/components/Remote/deferTerminalConnection.ts';
import {
  createTerminalResizeFrame,
  sendTerminalFrameWhenReady,
} from '../../../src/components/Remote/sendTerminalFrameWhenReady.ts';

test('strict-mode cleanup cancels the discarded terminal connection before consuming its token', async () => {
  let openedConnections = 0;

  const cancelDiscardedSetup = deferTerminalConnection(() => {
    openedConnections += 1;
  });
  cancelDiscardedSetup();

  deferTerminalConnection(() => {
    openedConnections += 1;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(openedConnections, 1);
});

test('terminal frames are held until the websocket session is ready', () => {
  const sentFrames = [];
  const socket = {
    readyState: 1,
    send: (frame) => sentFrames.push(frame),
  };
  const resize = { type: 'resize', cols: 100, rows: 30 };

  sendTerminalFrameWhenReady(socket, false, resize);
  assert.deepEqual(sentFrames, []);

  sendTerminalFrameWhenReady(socket, true, resize);
  assert.deepEqual(sentFrames.map((frame) => JSON.parse(frame)), [resize]);
});

test('terminal resize frames are normalized to websocket protocol boundaries', () => {
  assert.deepEqual(createTerminalResizeFrame(31_080, 1), {
    type: 'resize',
    cols: 500,
    rows: 5,
  });
  assert.deepEqual(createTerminalResizeFrame(Number.NaN, Number.NaN), {
    type: 'resize',
    cols: 80,
    rows: 24,
  });
});
