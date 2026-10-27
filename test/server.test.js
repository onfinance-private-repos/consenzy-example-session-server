import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { configFromEnv, createApp } from '../src/server.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(base, method, path, { body, token, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

describe('demo mode', () => {
  let server;
  let base;
  before(async () => {
    server = await listen(createApp(configFromEnv({})));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const session = async (external_ref = 'CUST-DEMO-0001', acting_as) =>
    (await call(base, 'POST', '/session', { body: { external_ref, acting_as } })).body;

  test('mints a cps_ session pointing at the mock API', async () => {
    const s = await session();
    assert.match(s.token, /^cps_demo_/);
    assert.equal(s.mode, 'demo');
    assert.equal(s.base_url, base);
    assert.deepEqual(s.capabilities, ['consents:write', 'requests:read', 'requests:write']);
  });

  test('refuses customers outside the allow-list', async () => {
    const r = await call(base, 'POST', '/session', { body: { external_ref: 'SOMEONE-ELSE' } });
    assert.equal(r.status, 403);
  });

  test('consent journey: notice in two languages, grant, check, withdraw', async () => {
    const { token } = await session();
    const me = await call(base, 'GET', '/v1/me', { token });
    assert.equal(me.body.external_ref, 'CUST-DEMO-0001');

    const en = (await call(base, 'GET', '/v1/me/notice?language=en', { token })).body;
    const hi = (await call(base, 'GET', '/v1/me/notice?language=hi', { token })).body;
    const ta = (await call(base, 'GET', '/v1/me/notice?language=ta', { token })).body;
    assert.equal(en.purposes.length, 3);
    assert.equal(hi.language, 'hi');
    assert.notEqual(hi.title, en.title);
    assert.equal(ta.language, 'en', 'falls back to English');

    const marketing = en.purposes.find((p) => p.code === 'marketing');
    const key = 'idem-1';
    const grant = await call(base, 'POST', '/v1/me/consents', {
      token,
      headers: { 'idempotency-key': key },
      body: { notice_id: en.id, purpose_ids: [marketing.id], channel: 'mobile_app' }
    });
    assert.equal(grant.status, 201);
    const replay = await call(base, 'POST', '/v1/me/consents', {
      token,
      headers: { 'idempotency-key': key },
      body: { notice_id: en.id, purpose_ids: [marketing.id], channel: 'mobile_app' }
    });
    assert.equal(replay.body[0].id, grant.body[0].id, 'Idempotency-Key replays the first response');

    let check = await call(base, 'POST', '/consent-check', { body: { external_ref: 'CUST-DEMO-0001', purpose_code: 'marketing' } });
    assert.equal(check.body.allowed, true);
    assert.equal(check.body.consent_id, grant.body[0].id);
    assert.match(check.body.ledger_hash, /^[0-9a-f]{64}$/);

    const active = (await call(base, 'GET', '/v1/me/consents?active_only=true', { token })).body;
    assert.equal(active.length, 1);
    const w = await call(base, 'POST', `/v1/me/consents/${active[0].id}/withdraw`, { token, body: { reason: 'No longer needed' } });
    assert.equal(w.body.status, 'withdrawn');
    check = await call(base, 'POST', '/consent-check', { body: { external_ref: 'CUST-DEMO-0001', purpose_code: 'marketing' } });
    assert.equal(check.body.allowed, false);
  });

  test('rights journey: file each type and list with the seeded WhatsApp request', async () => {
    const { token } = await session();
    const bodies = [
      { request_type: 'access', details: { note: 'Please send a summary' } },
      { request_type: 'correction', details: { fields: { address_line_1: '12 Demo Road' } } },
      { request_type: 'erasure', details: { reason: 'Closed my account' } },
      { request_type: 'grievance', details: { description: 'My erasure request is late' } }
    ];
    for (const b of bodies) {
      const r = await call(base, 'POST', '/v1/me/data-requests', { token, body: { ...b, channel: 'app' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.status, 'received');
      assert.equal(r.body.channel, 'app');
    }
    const bad = await call(base, 'POST', '/v1/me/data-requests', { token, body: { request_type: 'correction', details: {} } });
    assert.equal(bad.status, 422);
    assert.ok(Array.isArray(bad.body.detail));
    const list = (await call(base, 'GET', '/v1/me/data-requests', { token })).body;
    assert.ok(list.some((r) => r.channel === 'whatsapp'));
    assert.equal(list.length, 5);
  });

  test('guardian rule (s.9): a minor needs a guardian session', async () => {
    const child = await session('CUST-DEMO-CHILD-7');
    const n = (await call(base, 'GET', '/v1/me/notice', { token: child.token })).body;
    const refused = await call(base, 'POST', '/v1/me/consents', {
      token: child.token,
      body: { notice_id: n.id, purpose_ids: [n.purposes[0].id], channel: 'mobile_app' }
    });
    assert.equal(refused.status, 422);
    assert.match(refused.body.detail, /acting_as=guardian/);

    const guardian = await session('CUST-DEMO-CHILD-7', 'guardian');
    assert.equal(guardian.acting_as, 'guardian');
    const ok = await call(base, 'POST', '/v1/me/consents', {
      token: guardian.token,
      body: { notice_id: n.id, purpose_ids: [n.purposes[0].id], channel: 'mobile_app' }
    });
    assert.equal(ok.status, 201);

    const adultAsGuardian = await call(base, 'POST', '/session', { body: { external_ref: 'CUST-DEMO-0001', acting_as: 'guardian' } });
    assert.equal(adultAsGuardian.status, 422);
  });

  test('401 without a valid token; logout revokes', async () => {
    assert.equal((await call(base, 'GET', '/v1/me')).status, 401);
    const { token } = await session();
    assert.equal((await call(base, 'POST', '/v1/me/logout', { token })).status, 204);
    assert.equal((await call(base, 'GET', '/v1/me', { token })).status, 401);
  });
});

describe('live mode', () => {
  test('needs a cdm_ key and a base URL', () => {
    assert.throws(() => configFromEnv({ CONSENZY_MODE: 'live' }));
    assert.throws(() => configFromEnv({ CONSENZY_MODE: 'live', CONSENZY_BASE_URL: 'https://consenzy.example', CONSENZY_API_KEY: 'cps_x' }));
  });

  test('mints through Consenzy with the org key and never returns it', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ token: 'cps_live', session_id: 's', principal_id: 'p', expires_at: 'x', acting_as: 'data_principal', capabilities: [] }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    };
    const config = { ...configFromEnv({ CONSENZY_MODE: 'live', CONSENZY_BASE_URL: 'https://consenzy.example', CONSENZY_API_KEY: 'cdm_test_only' }), fetch: fakeFetch };
    const server = await listen(createApp(config));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await call(base, 'POST', '/session', { body: { external_ref: 'CUST-DEMO-0001' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.token, 'cps_live');
      assert.equal(r.body.base_url, 'https://consenzy.example');
      assert.equal(calls[0].url, 'https://consenzy.example/v1/principal-sessions');
      assert.equal(calls[0].init.headers.authorization, 'Bearer cdm_test_only');
      assert.ok(!JSON.stringify(r.body).includes('cdm_'));
      assert.equal((await call(base, 'GET', '/v1/me')).status, 404, 'no mock API in live mode');
    } finally {
      server.close();
    }
  });
});
