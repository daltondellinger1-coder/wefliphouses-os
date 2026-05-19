/**
 * REsimpli service.
 *
 * REsimpli does not publish a public REST API spec. Until docs are available,
 * this service:
 *   - probe()   tries several base URL + path + auth-header combinations and
 *               reports which one returns 200. Use via GET /api/resimpli/probe.
 *   - fetchLive() calls a single configured (base, path, auth-mode) combo.
 *
 * Any failure falls back to mock so the dashboard still renders.
 *
 * Once probe finds the right combo, set in .env:
 *   RESIMPLI_API_BASE, RESIMPLI_LEADS_PATH, RESIMPLI_AUTH_MODE
 *
 * V1 only pulls a single "leads" endpoint and maps what we can; weekly/monthly
 * funnel counts and lead-source ROI are computed locally when more data is
 * available. Until the response shape is confirmed we keep mock values for
 * anything we cannot map.
 */

const fs = require('fs');
const path = require('path');

const MOCK_PATH = path.join(__dirname, '..', 'data', 'mockREsimpli.json');

function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

function authHeaders(mode, key) {
  switch ((mode || 'bearer').toLowerCase()) {
    case 'bearer':
      return { Authorization: `Bearer ${key}` };
    case 'xapikey':
      return { 'X-API-Key': key };
    case 'apitoken':
      return { 'Api-Token': key };
    case 'token':
      return { Authorization: `Token ${key}` };
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

async function tryFetch(url, headers, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, bodyPreview: text.slice(0, 200), ok: res.ok };
  } catch (err) {
    return { status: 0, bodyPreview: err.message, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function probe() {
  const key = process.env.RESIMPLI_API_KEY;
  if (!key) return [{ note: 'RESIMPLI_API_KEY not set' }];

  const bases = [
    process.env.RESIMPLI_API_BASE,
    'https://api.resimpli.com',
    'https://app.resimpli.com',
    'https://resimpli.com',
  ].filter(Boolean);

  const paths = [
    '/api/v1/leads',
    '/api/leads',
    '/v1/leads',
    '/api/v1/me',
    '/api/v1/account',
  ];
  const modes = ['bearer', 'xapikey', 'apitoken', 'token'];

  const results = [];
  for (const base of bases) {
    for (const p of paths) {
      for (const mode of modes) {
        const url = base.replace(/\/+$/, '') + p;
        const r = await tryFetch(url, authHeaders(mode, key));
        results.push({
          url,
          mode,
          status: r.status,
          bodyPreview: r.bodyPreview,
        });
        if (r.ok) return [{ winner: { base, path: p, mode } }, ...results];
      }
      const urlQs =
        base.replace(/\/+$/, '') +
        p +
        (p.includes('?') ? '&' : '?') +
        'api_key=' +
        encodeURIComponent(key);
      const rqs = await tryFetch(urlQs, {});
      results.push({
        url: urlQs,
        mode: 'querystring',
        status: rqs.status,
        bodyPreview: rqs.bodyPreview,
      });
      if (rqs.ok)
        return [
          { winner: { base, path: p, mode: 'querystring' } },
          ...results,
        ];
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Light response -> dashboard mapping
// ---------------------------------------------------------------------------

function mapLeadsResponse(rawLeads) {
  // Normalize a flat array of lead objects from any reasonable shape.
  const arr = Array.isArray(rawLeads)
    ? rawLeads
    : Array.isArray(rawLeads?.data)
      ? rawLeads.data
      : Array.isArray(rawLeads?.leads)
        ? rawLeads.leads
        : [];

  const now = Date.now();
  const WEEK = 7 * 86400000;
  const MONTH = 30 * 86400000;

  const inWeek = (d) => d && now - new Date(d).getTime() <= WEEK;
  const inMonth = (d) => d && now - new Date(d).getTime() <= MONTH;

  const isQualified = (l) =>
    /qualif/i.test(l.status || l.stage || '') ||
    l.qualified === true;
  const isAppt = (l) =>
    /appoint|meeting/i.test(l.status || l.stage || '');
  const isOffer = (l) =>
    /offer/i.test(l.status || l.stage || '') ||
    l.offerAmount != null ||
    l.offer_amount != null;
  const isContract = (l) =>
    /contract|signed|under contract/i.test(l.status || l.stage || '');

  const weekly = {
    newLeads: arr.filter((l) => inWeek(l.createdAt || l.created_at)).length,
    qualifiedLeads: arr.filter(
      (l) => inWeek(l.createdAt || l.created_at) && isQualified(l),
    ).length,
    appointments: arr.filter(
      (l) => inWeek(l.updatedAt || l.updated_at) && isAppt(l),
    ).length,
    offersMade: arr.filter(
      (l) => inWeek(l.updatedAt || l.updated_at) && isOffer(l),
    ).length,
    contractsSigned: arr.filter(
      (l) => inWeek(l.updatedAt || l.updated_at) && isContract(l),
    ).length,
  };
  const monthly = {
    newLeads: arr.filter((l) => inMonth(l.createdAt || l.created_at)).length,
    qualifiedLeads: arr.filter(
      (l) => inMonth(l.createdAt || l.created_at) && isQualified(l),
    ).length,
    appointments: arr.filter(
      (l) => inMonth(l.updatedAt || l.updated_at) && isAppt(l),
    ).length,
    offersMade: arr.filter(
      (l) => inMonth(l.updatedAt || l.updated_at) && isOffer(l),
    ).length,
    contractsSigned: arr.filter(
      (l) => inMonth(l.updatedAt || l.updated_at) && isContract(l),
    ).length,
  };

  const pipeline = arr.slice(0, 25).map((l) => ({
    leadId: l.id || l.leadId || l._id,
    address: l.address || l.street || '',
    city: l.city || '',
    source: l.source || l.leadSource || 'Unknown',
    stage: l.status || l.stage || 'Unknown',
    assignedTo: l.assignedTo || l.assigned_to || l.owner || 'Unassigned',
    offerAmount: l.offerAmount ?? l.offer_amount ?? null,
    createdAt: l.createdAt || l.created_at || null,
    lastTouch: l.updatedAt || l.updated_at || l.lastTouch || null,
  }));

  return { weekly, monthly, pipeline };
}

async function fetchLive() {
  const base = process.env.RESIMPLI_API_BASE;
  const key = process.env.RESIMPLI_API_KEY;
  const mode = process.env.RESIMPLI_AUTH_MODE || 'bearer';
  const leadsPath = process.env.RESIMPLI_LEADS_PATH || '/api/v1/leads';
  if (!base || !key) throw new Error('REsimpli base or API key missing');

  const url = base.replace(/\/+$/, '') + leadsPath;
  const r = await tryFetch(url, authHeaders(mode, key));
  if (!r.ok) {
    throw new Error(
      `REsimpli ${r.status}: ${r.bodyPreview} (try /api/resimpli/probe to find the right combo)`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(r.bodyPreview);
  } catch {
    // body may be truncated by our 200-char preview; do a full fetch
    const full = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders(mode, key) },
    });
    raw = await full.json();
  }

  const mapped = mapLeadsResponse(raw);
  const mock = loadMock();
  // TODO map lead-source ROI + marketingSpend once we confirm the
  // marketing/spend endpoint shape. For now keep mock for those fields.
  return {
    ...mock,
    asOf: new Date().toISOString().slice(0, 10),
    weekly: mapped.weekly,
    monthly: mapped.monthly,
    pipeline: mapped.pipeline.length ? mapped.pipeline : mock.pipeline,
  };
}

async function getAcquisitionsSnapshot() {
  const mode = (process.env.DATA_MODE || 'mock').toLowerCase();
  const hasCreds = !!process.env.RESIMPLI_API_KEY;

  if (mode === 'live' && hasCreds) {
    try {
      return { source: 'live', data: await fetchLive() };
    } catch (err) {
      console.error('[resimpli] live fetch failed, using mock:', err.message);
      return { source: 'mock', data: loadMock(), error: err.message };
    }
  }
  return { source: 'mock', data: loadMock() };
}

module.exports = { getAcquisitionsSnapshot, probe };
