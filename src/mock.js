// Demo mode: an in-memory mock of the Consenzy principal API (/v1/me/*) and of the two org-key calls this server makes
// (minting a session, checking consent). It mirrors the real API's shapes and the rules the example apps exercise:
// capability checks, the s.9 guardian rule, Idempotency-Key replay, consent supersede/withdraw and request status.
// Everything is synthetic and lives in memory; restarting the server resets it.
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import fixtures from './fixtures.json' with { type: 'json' };

export const ALL_CAPABILITIES = ['consents:write', 'requests:read', 'requests:write'];
export const REQUEST_TYPES = ['access', 'correction', 'completion', 'updating', 'erasure', 'grievance', 'nomination'];
const GUARDIAN_REQUIRED =
  'this principal acts through a guardian: the session must be minted with acting_as=guardian (s.9)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMockStore(now = () => Date.now()) {
  const sessions = new Map(); // token -> session
  const consents = []; // MeConsentOut rows (plus external_ref)
  const requests = []; // DataRequestOut rows (plus external_ref, _receivedMs)
  const idempotency = new Map(); // `${principal}:${endpoint}:${key}` -> {status, body}

  for (const seed of fixtures.seed_data_requests) {
    const p = principalByRef(seed.external_ref);
    const receivedMs = now() - seed.received_days_ago * 86_400_000;
    requests.push(dataRequestRow(p, seed.request_type, seed.details, seed.channel, seed.channel_reference, receivedMs, seed.id, seed.status));
  }

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  function principalByRef(ref) {
    return fixtures.principals.find((p) => p.external_ref === ref) ?? null;
  }

  function dataRequestRow(p, type, details, channel, channelReference, receivedMs, id = randomUUID(), fixedStatus = null) {
    return {
      id,
      principal_id: p.principal_id,
      request_type: type,
      status: fixedStatus ?? 'received',
      channel,
      channel_reference: channelReference ?? null,
      details,
      response: null,
      assigned_to: null,
      due_at: iso(receivedMs + fixtures.request_sla_days * 86_400_000),
      received_at: iso(receivedMs),
      closed_at: null,
      created_at: iso(receivedMs),
      updated_at: iso(receivedMs),
      api_key_id: null,
      _ref: p.external_ref,
      _receivedMs: receivedMs,
      _fixedStatus: fixedStatus
    };
  }

  // Demo requests move on by themselves so the status-tracking screen has something to show.
  function progressed(row) {
    if (row._fixedStatus) return row;
    const age = (now() - row._receivedMs) / 1000;
    const { in_progress: ip, completed: done } = fixtures.status_progression_seconds;
    if (age >= done) {
      row.status = 'completed';
      row.closed_at ??= iso(row._receivedMs + done * 1000);
      row.response ??= { summary: `Demo: your ${row.request_type} request was completed.` };
      row.updated_at = row.closed_at;
    } else if (age >= ip) {
      row.status = 'in_progress';
      row.updated_at = iso(row._receivedMs + ip * 1000);
    }
    return row;
  }

  const publicRow = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));

  return {
    fixtures,
    mint({ external_ref, principal_id, acting_as = 'data_principal', capabilities, ttl_seconds = 900 }) {
      const p = external_ref ? principalByRef(external_ref) : fixtures.principals.find((x) => x.principal_id === principal_id);
      if (!p) return { status: 404, body: { detail: 'principal not found' } };
      if (acting_as === 'guardian' && !p.acts_through_guardian)
        return { status: 422, body: { detail: 'principal does not act through a guardian' } };
      const caps = capabilities ?? ALL_CAPABILITIES;
      if (caps.some((c) => !ALL_CAPABILITIES.includes(c)))
        return { status: 403, body: { detail: 'cannot grant capabilities the minting key lacks' } };
      const token = `cps_demo_${randomUUID().replaceAll('-', '')}`;
      const session = {
        token,
        session_id: randomUUID(),
        principal_id: p.principal_id,
        expires_at: iso(now() + ttl_seconds * 1000),
        acting_as,
        capabilities: [...caps].sort(),
        application_id: null
      };
      sessions.set(token, { ...session, principal: p, revoked: false });
      return { status: 201, body: session };
    },
    check({ external_ref, principal_id, purpose_code }) {
      const p = external_ref ? principalByRef(external_ref) : fixtures.principals.find((x) => x.principal_id === principal_id);
      if (!p) return { status: 404, body: { detail: 'principal not found' } };
      const c = consents.find((r) => r._ref === p.external_ref && r.purpose_code === purpose_code && r.status === 'active');
      if (!c) return { status: 200, body: { allowed: false, basis: null, consent_id: null, expires_at: null, ledger_event_id: null, ledger_hash: null } };
      return {
        status: 200,
        body: { allowed: true, basis: 'consent', consent_id: c.id, expires_at: c.expires_at, ledger_event_id: c._ledgerEventId, ledger_hash: c._ledgerHash }
      };
    },
    session(token) {
      const s = sessions.get(token);
      if (!s || s.revoked || Date.parse(s.expires_at) <= now()) return null;
      return s;
    },
    logout(token) {
      const s = sessions.get(token);
      if (s) s.revoked = true;
    },
    me(s) {
      const p = s.principal;
      return {
        principal_id: p.principal_id,
        external_ref: p.external_ref,
        preferred_language: p.preferred_language,
        acts_through_guardian: p.acts_through_guardian,
        guardian_verified: p.guardian_verified,
        acting_as: s.acting_as,
        capabilities: s.capabilities
      };
    },
    notice(language) {
      const tr = fixtures.notice.translations[language] ?? fixtures.notice.translations.en;
      const lang = fixtures.notice.translations[language] ? language : 'en';
      return {
        id: fixtures.notice.id,
        version: fixtures.notice.version,
        language: lang,
        title: tr.title,
        body: tr.body,
        purposes: fixtures.purposes.map((pp) => ({
          id: pp.id,
          code: pp.code,
          name: tr.purposes[pp.code].name,
          description: tr.purposes[pp.code].description,
          data_categories: pp.data_categories,
          retention_days: pp.retention_days
        }))
      };
    },
    listConsents(s, activeOnly) {
      return consents
        .filter((c) => c._ref === s.principal.external_ref && (!activeOnly || c.status === 'active'))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(publicRow);
    },
    grant(s, body) {
      if (!s.capabilities.includes('consents:write')) return { status: 403, body: { detail: 'session lacks the consents:write capability' } };
      if (s.principal.acts_through_guardian && s.acting_as !== 'guardian') return { status: 422, body: { detail: GUARDIAN_REQUIRED } };
      if (body?.notice_id !== fixtures.notice.id) return { status: 404, body: { detail: 'notice not found' } };
      const ids = body.purpose_ids;
      if (!Array.isArray(ids) || ids.length === 0)
        return { status: 422, body: { detail: [{ loc: ['body', 'purpose_ids'], msg: 'List should have at least 1 item', type: 'too_short' }] } };
      const purposes = ids.map((id) => fixtures.purposes.find((pp) => pp.id === id));
      if (purposes.some((pp) => !pp)) return { status: 422, body: { detail: 'purpose not in notice' } };
      const t = now();
      const out = purposes.map((pp) => {
        for (const old of consents) {
          if (old._ref === s.principal.external_ref && old.purpose_code === pp.code && old.status === 'active') {
            old.status = 'superseded';
            old.updated_at = iso(t);
          }
        }
        const id = randomUUID();
        const row = {
          id,
          principal_id: s.principal.principal_id,
          purpose_id: pp.id,
          purpose_code: pp.code,
          notice_id: fixtures.notice.id,
          status: 'active',
          channel: body.channel ?? 'mobile_app',
          consent_manager_ref: null,
          application_id: null,
          given_at: iso(t),
          expires_at: body.expires_at ?? null,
          withdrawn_at: null,
          withdrawal_reason: null,
          created_at: iso(t),
          updated_at: iso(t),
          _ref: s.principal.external_ref,
          _ledgerEventId: consents.length + 1,
          _ledgerHash: createHash('sha256').update(`${id}:${t}`).digest('hex')
        };
        consents.push(row);
        return publicRow(row);
      });
      return { status: 201, body: out };
    },
    withdraw(s, consentId, reason) {
      if (!s.capabilities.includes('consents:write')) return { status: 403, body: { detail: 'session lacks the consents:write capability' } };
      const c = consents.find((r) => r.id === consentId && r._ref === s.principal.external_ref);
      if (!c) return { status: 404, body: { detail: 'consent not found' } };
      if (c.status !== 'active') return { status: 409, body: { detail: 'consent is not active' } };
      const t = iso(now());
      Object.assign(c, { status: 'withdrawn', withdrawn_at: t, withdrawal_reason: reason ?? null, updated_at: t });
      return { status: 200, body: publicRow(c) };
    },
    listRequests(s) {
      if (!s.capabilities.includes('requests:read')) return { status: 403, body: { detail: 'session lacks the requests:read capability' } };
      const rows = requests
        .filter((r) => r._ref === s.principal.external_ref)
        .map(progressed)
        .sort((a, b) => b.received_at.localeCompare(a.received_at))
        .map(publicRow);
      return { status: 200, body: rows };
    },
    fileRequest(s, body) {
      if (!s.capabilities.includes('requests:write')) return { status: 403, body: { detail: 'session lacks the requests:write capability' } };
      const type = body?.request_type;
      if (!REQUEST_TYPES.includes(type))
        return { status: 422, body: { detail: [{ loc: ['body', 'request_type'], msg: `Input should be ${REQUEST_TYPES.join(', ')}`, type: 'literal_error' }] } };
      const problem = validateDetails(type, body.details ?? {});
      if (problem) return { status: 422, body: { detail: [{ loc: ['body', 'details', problem.field], msg: problem.msg, type: 'value_error' }] } };
      const row = dataRequestRow(s.principal, type, body.details ?? {}, body.channel ?? 'app', null, now());
      requests.push(row);
      return { status: 201, body: publicRow(row) };
    },
    idempotent(s, endpoint, key, run) {
      if (!key) return run();
      const k = `${s.principal.principal_id}:${endpoint}:${key}`;
      if (idempotency.has(k)) return idempotency.get(k);
      const res = run();
      if (res.status < 300) idempotency.set(k, res);
      return res;
    }
  };
}

function validateDetails(type, d) {
  const short = (v) => v == null || (typeof v === 'string' && v.length <= 500);
  switch (type) {
    case 'access':
      return short(d.note) ? null : { field: 'note', msg: 'String should have at most 500 characters' };
    case 'correction':
    case 'completion':
    case 'updating': {
      const f = d.fields;
      if (!f || typeof f !== 'object' || Object.keys(f).length === 0) return { field: 'fields', msg: 'Dictionary should have at least 1 item' };
      const bad = Object.keys(f).find((k) => !/^[a-z][a-z0-9_]{0,63}$/.test(k));
      return bad ? { field: 'fields', msg: `invalid field name: ${bad}` } : null;
    }
    case 'erasure':
      return short(d.reason) ? null : { field: 'reason', msg: 'String should have at most 500 characters' };
    case 'grievance':
      if (typeof d.description !== 'string' || d.description.trim() === '') return { field: 'description', msg: 'Field required' };
      if (d.related_request_id != null && !UUID_RE.test(d.related_request_id)) return { field: 'related_request_id', msg: 'Input should be a valid UUID' };
      return null;
    case 'nomination':
      if (!d.nominee_name) return { field: 'nominee_name', msg: 'Field required' };
      if (!d.relationship) return { field: 'relationship', msg: 'Field required' };
      if (!d.nominee_email && !d.nominee_phone) return { field: 'nominee_email', msg: 'nominee_email or nominee_phone is required' };
      return null;
    default:
      return null;
  }
}

/** The /v1/me/* routes, authenticated with the demo `cps_demo_…` tokens this server mints. */
export function mockPrincipalApi(store) {
  const r = express.Router();
  r.use(express.json());
  r.use((req, res, next) => {
    const m = /^Bearer (cps_\S+)$/.exec(req.get('authorization') ?? '');
    const s = m && store.session(m[1]);
    if (!s) return res.status(401).json({ detail: 'invalid or expired session token' });
    req.cps = s;
    req.cpsToken = m[1];
    next();
  });
  const send = (res, { status, body }) => res.status(status).json(body);

  r.get('/', (req, res) => res.json(store.me(req.cps)));
  r.get('/notice', (req, res) => res.json(store.notice(String(req.query.language ?? req.cps.principal.preferred_language))));
  r.get('/consents', (req, res) => {
    const activeOnly = String(req.query.active_only ?? 'false') === 'true';
    const { limit, offset } = page(req);
    res.json(store.listConsents(req.cps, activeOnly).slice(offset, offset + limit));
  });
  r.post('/consents', (req, res) =>
    send(res, store.idempotent(req.cps, 'consents', req.get('idempotency-key'), () => store.grant(req.cps, req.body)))
  );
  r.post('/consents/:id/withdraw', (req, res) => send(res, store.withdraw(req.cps, req.params.id, req.body?.reason)));
  r.get('/data-requests', (req, res) => {
    const out = store.listRequests(req.cps);
    if (out.status !== 200) return send(res, out);
    const { limit, offset } = page(req);
    res.json(out.body.slice(offset, offset + limit));
  });
  r.post('/data-requests', (req, res) =>
    send(res, store.idempotent(req.cps, 'data-requests', req.get('idempotency-key'), () => store.fileRequest(req.cps, req.body)))
  );
  r.get('/breach-notices', (_req, res) => res.json([]));
  r.post('/breach-notices/:id/acknowledge', (_req, res) => res.status(404).json({ detail: 'breach notice not found' }));
  r.post('/logout', (req, res) => {
    store.logout(req.cpsToken);
    res.status(204).end();
  });
  return r;
}

function page(req) {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  return { limit, offset };
}
