// The example apps' backend. It does the two things an app must never do itself, because both need an org API key:
//   POST /session        mint a short-lived principal session (cps_…) for the signed-in customer
//   POST /consent-check  ask the consent ledger whether a purpose is allowed before processing
// In demo mode (the default) it also serves an in-memory mock of the principal API under /v1/me, so the apps run
// without any Consenzy organisation. In live mode it calls your Consenzy deployment with CONSENZY_API_KEY.
import express from 'express';
import { createMockStore, mockPrincipalApi } from './mock.js';

/**
 * @param {object} config
 * @param {'demo'|'live'} config.mode
 * @param {string} [config.baseUrl]      CONSENZY_BASE_URL (live mode)
 * @param {string} [config.apiKey]       CONSENZY_API_KEY (live mode, server-side only)
 * @param {string[]} config.allowedExternalRefs which customers this example may mint sessions for
 * @param {string} [config.publicUrl]   demo mode: the URL the apps should use for the mock API (default: the request's host)
 * @param {typeof fetch} [config.fetch]
 */
export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  const store = config.mode === 'demo' ? createMockStore() : null;
  const doFetch = config.fetch ?? fetch;

  app.get('/healthz', (_req, res) => res.json({ ok: true, mode: config.mode }));

  // Demo customers the apps offer on their sign-in screen (synthetic).
  app.get('/demo-customers', (_req, res) =>
    res.json(
      (store?.fixtures.principals ?? []).length
        ? store.fixtures.principals.map(({ external_ref, label, acts_through_guardian }) => ({ external_ref, label, acts_through_guardian }))
        : config.allowedExternalRefs.map((external_ref) => ({ external_ref, label: external_ref, acts_through_guardian: false }))
    )
  );

  // Replace this with your own authentication: derive external_ref from the signed-in user, never trust the client.
  // The allow-list stops this example from becoming an open session-minting service.
  app.post('/session', async (req, res) => {
    const { external_ref, acting_as = 'data_principal' } = req.body ?? {};
    if (typeof external_ref !== 'string' || !config.allowedExternalRefs.includes(external_ref))
      return res.status(403).json({ detail: 'unknown customer' });
    if (!['data_principal', 'guardian'].includes(acting_as)) return res.status(422).json({ detail: 'acting_as must be data_principal or guardian' });
    const mintBody = { external_ref, acting_as, ttl_seconds: 900 };
    if (store) {
      const out = store.mint(mintBody);
      if (out.status !== 201) return res.status(out.status).json(out.body);
      return res.json({ ...out.body, base_url: config.publicUrl ?? `${req.protocol}://${req.get('host')}`, mode: 'demo' });
    }
    const upstream = await callConsenzy('/v1/principal-sessions', mintBody);
    if (upstream.status !== 201) return res.status(upstream.status === 404 ? 404 : 502).json({ detail: upstream.body?.detail ?? 'session mint failed' });
    return res.json({ ...upstream.body, base_url: config.baseUrl, mode: 'live' });
  });

  app.post('/consent-check', async (req, res) => {
    const { external_ref, purpose_code } = req.body ?? {};
    if (typeof external_ref !== 'string' || !config.allowedExternalRefs.includes(external_ref))
      return res.status(403).json({ detail: 'unknown customer' });
    if (typeof purpose_code !== 'string' || !purpose_code) return res.status(422).json({ detail: 'purpose_code is required' });
    if (store) {
      const out = store.check({ external_ref, purpose_code });
      return res.status(out.status).json(out.body);
    }
    const upstream = await callConsenzy('/v1/consents/check', { external_ref, purpose_code });
    if (upstream.status !== 200) return res.status(502).json({ detail: upstream.body?.detail ?? 'consent check failed' });
    return res.json(upstream.body);
  });

  if (store) app.use('/v1/me', mockPrincipalApi(store));
  app.use((_req, res) => res.status(404).json({ detail: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ detail: err.status ? err.message : 'internal error' }));

  async function callConsenzy(path, body) {
    let r;
    try {
      r = await doFetch(new URL(path, config.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      return { status: 599, body: { detail: 'Consenzy is unreachable' } };
    }
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* empty or non-JSON body */
    }
    return { status: r.status, body: json };
  }

  return app;
}

/** Reads the configuration from the environment. Demo mode unless CONSENZY_MODE=live. */
export function configFromEnv(env = process.env) {
  const mode = env.CONSENZY_MODE === 'live' ? 'live' : 'demo';
  const allowedExternalRefs = (env.ALLOWED_EXTERNAL_REFS ?? 'CUST-DEMO-0001,CUST-DEMO-CHILD-7')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (mode === 'live') {
    if (!env.CONSENZY_BASE_URL || !env.CONSENZY_API_KEY) throw new Error('live mode needs CONSENZY_BASE_URL and CONSENZY_API_KEY');
    if (!env.CONSENZY_API_KEY.startsWith('cdm_')) throw new Error('CONSENZY_API_KEY must be an org API key (cdm_…)');
  }
  return {
    mode,
    baseUrl: env.CONSENZY_BASE_URL,
    apiKey: env.CONSENZY_API_KEY,
    allowedExternalRefs,
    publicUrl: env.PUBLIC_URL || undefined
  };
}
