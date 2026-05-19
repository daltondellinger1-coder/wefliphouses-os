/**
 * FlipperForce service.
 *
 * FlipperForce does not publish a public REST API. The key our operator
 * pasted from FlipperForce settings looks like a Laravel Crypt::encryptString
 * envelope ({iv, value, mac, tag}), which the FlipperForce backend would
 * decrypt server-side. Until we have docs confirming the wire format, this
 * service can:
 *
 *   - probe()   try several common auth header + endpoint combinations and
 *               report which one succeeds. Use via GET /api/flipperforce/probe.
 *   - fetchLive() try the single pattern configured by
 *               FLIPPERFORCE_AUTH_MODE (bearer | xapikey | querystring) at
 *               base URL FLIPPERFORCE_API_BASE and path FLIPPERFORCE_PROJECTS_PATH
 *               (default /api/v1/projects).
 *
 * Any failure falls back to mock so the dashboard still renders.
 *
 * CSV fallback: drop backend/data/flipperforce_export.csv and we'll read it
 * instead of calling the API (column mapping below).
 */

const fs = require('fs');
const path = require('path');

const MOCK_PATH = path.join(__dirname, '..', 'data', 'mockFlipperForce.json');
const CSV_PATH = path.join(__dirname, '..', 'data', 'flipperforce_export.csv');

function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Auth strategies
// ---------------------------------------------------------------------------

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
    case 'cookie':
      return { Cookie: `laravel_session=${key}` };
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
  const base = process.env.FLIPPERFORCE_API_BASE || 'https://app.flipperforce.com';
  const key = process.env.FLIPPERFORCE_API_KEY;
  if (!key) return [{ note: 'FLIPPERFORCE_API_KEY not set' }];

  const paths = [
    '/api/v1/projects',
    '/api/projects',
    '/api/v1/deals',
    '/api/v1/me',
    '/api/v1/account',
  ];
  const modes = ['bearer', 'xapikey', 'apitoken', 'token', 'cookie'];

  const results = [];
  for (const p of paths) {
    for (const mode of modes) {
      const url = base.replace(/\/+$/, '') + p;
      const r = await tryFetch(url, authHeaders(mode, key));
      results.push({ url, mode, status: r.status, bodyPreview: r.bodyPreview });
      if (r.ok) return [{ winner: { url, mode } }, ...results];
    }
    // Also try query-string variant once per path
    const urlQs =
      base.replace(/\/+$/, '') + p + (p.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
    const rqs = await tryFetch(urlQs, {});
    results.push({ url: urlQs, mode: 'querystring', status: rqs.status, bodyPreview: rqs.bodyPreview });
    if (rqs.ok) return [{ winner: { url: urlQs, mode: 'querystring' } }, ...results];
  }
  return results;
}

// ---------------------------------------------------------------------------
// CSV fallback parser (minimal — assumes header row)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i]?.trim()));
    return row;
  });
}

function csvRowToProject(row) {
  // Operator-friendly column names. Adjust as needed once FlipperForce export
  // schema is confirmed.
  return {
    projectId: row.projectId || row.id || row['Project ID'],
    address: row.address || row['Address'],
    city: row.city || row['City'],
    status: row.status || row['Status'],
    phase: row.phase || row['Phase'],
    purchaseDate: row.purchaseDate || row['Purchase Date'],
    rehabStartDate: row.rehabStartDate || row['Rehab Start'],
    targetCompletionDate: row.targetCompletionDate || row['Target Completion'],
    listDate: row.listDate || row['List Date'] || null,
    saleDate: row.saleDate || row['Sale Date'] || null,
    budgetedRehab: Number(row.budgetedRehab || row['Budgeted Rehab'] || 0),
    actualRehabSpend: Number(row.actualRehabSpend || row['Actual Rehab'] || 0),
    percentComplete: Number(row.percentComplete || row['% Complete'] || 0),
    lastProjectUpdate: row.lastProjectUpdate || row['Last Update'],
    projectManager: row.projectManager || row['PM'],
    nextAction: row.nextAction || row['Next Action'] || null,
    blockers: row.blockers || row['Blockers'] || null,
    arv: Number(row.arv || row['ARV'] || 0),
    purchasePrice: Number(row.purchasePrice || row['Purchase Price'] || 0),
    tasks: [],
  };
}

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

async function fetchLive() {
  // 1. CSV drop wins if present
  if (fs.existsSync(CSV_PATH)) {
    const text = fs.readFileSync(CSV_PATH, 'utf8');
    const rows = parseCsv(text);
    const projects = rows.map(csvRowToProject).filter((p) => p.projectId);
    return { asOf: new Date().toISOString().slice(0, 10), projects };
  }

  // 2. API call with configured strategy
  const base = process.env.FLIPPERFORCE_API_BASE;
  const key = process.env.FLIPPERFORCE_API_KEY;
  const mode = process.env.FLIPPERFORCE_AUTH_MODE || 'bearer';
  const projectsPath = process.env.FLIPPERFORCE_PROJECTS_PATH || '/api/v1/projects';
  if (!base || !key) throw new Error('FlipperForce base URL or API key missing');

  const url = base.replace(/\/+$/, '') + projectsPath;
  const r = await tryFetch(url, authHeaders(mode, key));
  if (!r.ok) {
    throw new Error(
      `FlipperForce ${r.status}: ${r.bodyPreview} (try /api/flipperforce/probe to find the right auth mode)`,
    );
  }
  const data = JSON.parse(r.bodyPreview);
  // TODO once we confirm response shape, map to { asOf, projects: [...] }
  return { asOf: new Date().toISOString().slice(0, 10), projects: data.projects || data };
}

async function getProjects() {
  const mode = (process.env.DATA_MODE || 'mock').toLowerCase();
  const hasCreds = !!process.env.FLIPPERFORCE_API_KEY;

  if (mode === 'live' && (hasCreds || fs.existsSync(CSV_PATH))) {
    try {
      return { source: 'live', data: await fetchLive() };
    } catch (err) {
      console.error('[flipperforce] live fetch failed, using mock:', err.message);
      return { source: 'mock', data: loadMock(), error: err.message };
    }
  }
  return { source: 'mock', data: loadMock() };
}

module.exports = { getProjects, probe };
