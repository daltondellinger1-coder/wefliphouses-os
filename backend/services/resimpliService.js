/**
 * REsimpli service wrapper.
 *
 * REsimpli API access typically requires contacting their team.
 * V1 returns mock data; wire fetchLive() once credentials/docs are obtained.
 *
 * Expected endpoints (TODO confirm with REsimpli):
 *   GET /v1/leads?since=<iso>
 *   GET /v1/pipeline
 *   GET /v1/marketing/spend?range=mtd
 */

const fs = require('fs');
const path = require('path');

const MOCK_PATH = path.join(__dirname, '..', 'data', 'mockREsimpli.json');

function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

async function fetchLive() {
  // TODO: implement real REsimpli calls.
  throw new Error('REsimpli live mode not yet implemented');
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

module.exports = { getAcquisitionsSnapshot };
