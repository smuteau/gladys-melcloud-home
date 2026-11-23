import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MELCloudHomeApi, API_ENDPOINT, WS_HASH_ENDPOINT } from '../src/melcloud-home-api.js';

const CONTEXT = {
  buildings: [{ id: 'b1', airToAirUnits: [{ id: 'u1' }, { id: 'u2' }] }],
  guestBuildings: [{ id: 'b2', airToAirUnits: [{ id: 'u3' }] }],
};

test('storeTokens stores tokens, persists the refresh token and computes expiry', async () => {
  let persisted = null;
  const api = new MELCloudHomeApi({
    persistRefreshToken: (t) => {
      persisted = t;
    },
    now: () => 1_000_000,
  });
  await api.storeTokens({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  assert.equal(api.accessToken, 'a');
  assert.equal(api.refreshToken, 'r');
  assert.equal(persisted, 'r');
  assert.equal(api.tokenExpiresAt, 1_000_000 + (3600 - 60) * 1000);
});

test('getAccessToken returns the cached token while valid', async () => {
  let refreshCalls = 0;
  const api = new MELCloudHomeApi({
    oauthModule: {
      refresh: async () => {
        refreshCalls += 1;
        return {};
      },
    },
    now: () => 0,
  });
  api.accessToken = 'cached';
  api.tokenExpiresAt = 10_000;
  assert.equal(await api.getAccessToken(), 'cached');
  assert.equal(refreshCalls, 0);
});

test('getAccessToken refreshes with the refresh token', async () => {
  const api = new MELCloudHomeApi({
    refreshToken: 'r',
    oauthModule: { refresh: async () => ({ access_token: 'fresh', refresh_token: 'r2' }) },
    now: () => 0,
  });
  assert.equal(await api.getAccessToken(), 'fresh');
});

test('getAccessToken falls back to a full login when refresh fails', async () => {
  let loggedIn = false;
  const api = new MELCloudHomeApi({
    email: 'a',
    password: 'b',
    refreshToken: 'bad',
    oauthModule: {
      refresh: async () => {
        throw new Error('expired');
      },
      login: async () => {
        loggedIn = true;
        return { access_token: 'via-login' };
      },
    },
    now: () => 0,
  });
  assert.equal(await api.getAccessToken(), 'via-login');
  assert.ok(loggedIn);
});

test('getAccessToken throws without credentials or refresh token', async () => {
  const api = new MELCloudHomeApi({ oauthModule: {}, now: () => 0 });
  await assert.rejects(() => api.getAccessToken(), /missing credentials/);
});

test('listAtaUnits flattens units from buildings and guest buildings', async () => {
  const api = new MELCloudHomeApi({
    now: () => 0,
    httpClient: { get: async () => ({ data: CONTEXT }) },
  });
  api.accessToken = 'a';
  api.tokenExpiresAt = 10_000;
  const units = await api.listAtaUnits();
  assert.deepEqual(units, [
    { id: 'u1', buildingId: 'b1' },
    { id: 'u2', buildingId: 'b1' },
    { id: 'u3', buildingId: 'b2' },
  ]);
});

test('setAtaUnit sends a PUT with the payload and auth header', async () => {
  const calls = [];
  const api = new MELCloudHomeApi({
    now: () => 0,
    httpClient: {
      put: async (url, payload, options) => {
        calls.push({ url, payload, options });
      },
    },
  });
  api.accessToken = 'token';
  api.tokenExpiresAt = 10_000;
  await api.setAtaUnit('u1', { power: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_ENDPOINT}/monitor/ataunit/u1`);
  assert.deepEqual(calls[0].payload, { power: false });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
});

// --- WebSocket hash ----------------------------------------------------------

const apiWithHashResponse = (data) => {
  const calls = [];
  const api = new MELCloudHomeApi({
    httpClient: {
      get: async (url, options) => {
        calls.push({ url, options });
        return { data };
      },
    },
    now: () => 0,
  });
  api.accessToken = 'token';
  api.tokenExpiresAt = 10_000;
  return { api, calls };
};

test('getWebSocketHash calls the lambda endpoint with the bearer token', async () => {
  const { api, calls } = apiWithHashResponse({ hash: 'H', userId: 'U' });
  assert.equal(await api.getWebSocketHash(), 'H');
  assert.equal(calls[0].url, WS_HASH_ENDPOINT);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  // The hash does NOT come from the BFF: it has its own host.
  assert.ok(!WS_HASH_ENDPOINT.startsWith(API_ENDPOINT));
});

test('getWebSocketHash accepts a bare string response', async () => {
  // Both shapes occur in the wild.
  const { api } = apiWithHashResponse('  H  ');
  assert.equal(await api.getWebSocketHash(), 'H');
});

test('getWebSocketHash throws when no hash comes back', async () => {
  for (const data of [{}, '', '   ', null, { hash: 42 }]) {
    const { api } = apiWithHashResponse(data);
    await assert.rejects(() => api.getWebSocketHash(), /no WebSocket hash/);
  }
});

const signalApi = (data, calls = []) =>
  new MELCloudHomeApi({
    now: () => Date.UTC(2026, 10, 23, 10, 15, 30),
    httpClient: {
      get: async (url, options) => {
        calls.push({ url, options });
        return { data };
      },
    },
  });

test('getWifiSignal asks the telemetry for the rssi of the last hours, in UTC', async () => {
  const calls = [];
  const api = signalApi({}, calls);
  api.accessToken = 'tok';
  api.tokenExpiresAt = Infinity;
  assert.equal(await api.getWifiSignal('u 1'), null);
  assert.equal(calls[0].url, `${API_ENDPOINT}/telemetry/telemetry/actual/u%201`);
  assert.deepEqual(calls[0].options.params, {
    from: '2026-11-23 04:15',
    to: '2026-11-23 10:15',
    measure: 'rssi',
  });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
});

test('getWifiSignal returns the newest reading, whatever the order', async () => {
  const api = signalApi({
    measureData: [
      {
        values: [
          { time: '2026-11-23 09:00:00', value: '-70' },
          { time: '2026-11-23 10:05:00', value: '-63.6' },
          { time: '2026-11-23 08:00:00', value: '-50' },
        ],
      },
      {
        values: [
          { time: 'garbage', value: '-40' },
          { time: '2026-11-23T10:10:00Z', value: '' },
        ],
      },
      null,
      {},
    ],
  });
  api.accessToken = 'tok';
  api.tokenExpiresAt = Infinity;
  assert.deepEqual(await api.getWifiSignal('u1'), {
    value: -64,
    time: new Date('2026-11-23T10:05:00Z'),
  });
});

test('getWifiSignal reads a stamp with an offset as that instant', async () => {
  const api = signalApi({
    measureData: [
      {
        values: [
          { time: '2026-11-23T11:00:00+01:00', value: -55 },
          { time: '2026-11-23T10:30:00Z', value: -60 },
        ],
      },
    ],
  });
  api.accessToken = 'tok';
  api.tokenExpiresAt = Infinity;
  assert.deepEqual(await api.getWifiSignal('u1'), {
    value: -60,
    time: new Date('2026-11-23T10:30:00Z'),
  });
});
