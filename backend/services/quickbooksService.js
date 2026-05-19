/**
 * QuickBooks Online service wrapper.
 *
 * V1 returns mock data so the dashboard runs end-to-end without credentials.
 * When DATA_MODE=live AND credentials are present, this attempts real calls
 * and falls back to mock on any failure (logged, never crashes the dashboard).
 *
 * Real wiring (TODO):
 *   - OAuth 2.0 token refresh against https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *   - Reports API:
 *       /v3/company/{realmId}/reports/BalanceSheet
 *       /v3/company/{realmId}/reports/ProfitAndLoss
 *       /v3/company/{realmId}/reports/AgedPayables
 *       /v3/company/{realmId}/reports/ProfitAndLossDetail?classid=<class>
 *   - Query API for accounts / classes / vendors
 *   - Map QBO "Class" (one per property) -> our propertyId
 */

const fs = require('fs');
const path = require('path');

const MOCK_PATH = path.join(__dirname, '..', 'data', 'mockQuickBooks.json');

function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

async function fetchLive() {
  // TODO: implement real QBO calls. Throw to trigger mock fallback for now.
  throw new Error('QBO live mode not yet implemented');
}

async function getFinancialSnapshot() {
  const mode = (process.env.DATA_MODE || 'mock').toLowerCase();
  const hasCreds =
    !!process.env.QBO_ACCESS_TOKEN &&
    !!process.env.QBO_REALM_ID &&
    !!process.env.QBO_CLIENT_ID;

  if (mode === 'live' && hasCreds) {
    try {
      return { source: 'live', data: await fetchLive() };
    } catch (err) {
      console.error('[quickbooks] live fetch failed, using mock:', err.message);
      return { source: 'mock', data: loadMock(), error: err.message };
    }
  }
  return { source: 'mock', data: loadMock() };
}

module.exports = { getFinancialSnapshot };
