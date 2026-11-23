import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWifiSignalReader } from '../src/wifiSignal.js';

const at = (iso, value) => ({ value, time: new Date(iso) });

test('a reading is published once, stamped with its own time', async () => {
  const readings = [at('2026-11-23T10:00:00Z', -64), at('2026-11-23T10:00:00Z', -64)];
  const reader = createWifiSignalReader({ getWifiSignal: async () => readings.shift() });
  assert.deepEqual(await reader.read('u1', 'f1'), {
    device_feature_external_id: 'f1',
    state: -64,
    created_at: '2026-11-23T10:00:00.000Z',
  });
  assert.equal(await reader.read('u1', 'f1'), null, 'same reading: nothing new');
});

test('a newer reading is published, an older one is not', async () => {
  const readings = [
    at('2026-11-23T10:00:00Z', -64),
    at('2026-11-23T09:00:00Z', -70),
    at('2026-11-23T10:30:00Z', -58),
  ];
  const reader = createWifiSignalReader({ getWifiSignal: async () => readings.shift() });
  await reader.read('u1', 'f1');
  assert.equal(await reader.read('u1', 'f1'), null);
  assert.equal((await reader.read('u1', 'f1')).state, -58);
});

test('features are tracked apart, and forget publishes again', async () => {
  const reader = createWifiSignalReader({
    getWifiSignal: async () => at('2026-11-23T10:00:00Z', -64),
  });
  assert.ok(await reader.read('u1', 'f1'));
  assert.ok(await reader.read('u2', 'f2'));
  assert.equal(await reader.read('u1', 'f1'), null);
  reader.forget();
  assert.ok(await reader.read('u1', 'f1'));
});

test('no reading or a failed request publishes nothing', async () => {
  const empty = createWifiSignalReader({ getWifiSignal: async () => null });
  assert.equal(await empty.read('u1', 'f1'), null);
  const failing = createWifiSignalReader({
    getWifiSignal: async () => {
      throw new Error('HTTP 503');
    },
  });
  assert.equal(await failing.read('u1', 'f1'), null);
});
