/**
 * FlipperForce service wrapper.
 *
 * FlipperForce does not publish a public REST API as of 2026-05.
 * V1 options:
 *   1. Mock mode (default).
 *   2. CSV export from FlipperForce dropped at backend/data/flipperforce_export.csv
 *      and parsed here.
 *   3. Webhook ingest via Zapier/Make pushing project updates into a local store.
 *
 * If/when a partner API is granted, wire it in fetchLive().
 */

const fs = require('fs');
const path = require('path');

const MOCK_PATH = path.join(__dirname, '..', 'data', 'mockFlipperForce.json');

function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

async function fetchLive() {
  // TODO: implement when API or CSV path is provided.
  throw new Error('FlipperForce live mode not yet implemented');
}

async function getProjects() {
  const mode = (process.env.DATA_MODE || 'mock').toLowerCase();
  const hasCreds = !!process.env.FLIPPERFORCE_API_KEY && !!process.env.FLIPPERFORCE_API_BASE;

  if (mode === 'live' && hasCreds) {
    try {
      return { source: 'live', data: await fetchLive() };
    } catch (err) {
      console.error('[flipperforce] live fetch failed, using mock:', err.message);
      return { source: 'mock', data: loadMock(), error: err.message };
    }
  }
  return { source: 'mock', data: loadMock() };
}

module.exports = { getProjects };
