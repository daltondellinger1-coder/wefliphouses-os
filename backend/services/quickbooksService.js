/**
 * QuickBooks Online service.
 *
 * Live mode flow:
 *   1. One-time: operator visits /api/qbo/connect → Intuit authorize page →
 *      returns to /api/qbo/callback which exchanges the code for tokens and
 *      persists them at backend/data/qbo_tokens.json (gitignored).
 *   2. Every request: ensureAccessToken() refreshes if expired, then we call
 *      the QBO Reports API in parallel and map results into the same shape
 *      as mockQuickBooks.json so downstream code is unchanged.
 *   3. Any individual report failure falls back to the mock value for that
 *      field; a top-level fetch failure falls back to full mock and surfaces
 *      a "Missing data from quickbooks" alert.
 *
 * Reports used:
 *   - BalanceSheet                              → cashOnHand, bankBalances
 *   - ProfitAndLoss (date_macro=This Month-to-date)  → monthlyIncome,
 *                                                       monthlyExpenses,
 *                                                       monthlyBurnRate
 *   - ProfitAndLoss (summarize_column_by=Class)  → per-property classExpenses
 *   - AgedPayables                              → apOutstanding, apAging
 */

const fs = require('fs');
const path = require('path');

const MOCK_PATH = path.join(__dirname, '..', 'data', 'mockQuickBooks.json');
const TOKEN_PATH = path.join(__dirname, '..', 'data', 'qbo_tokens.json');

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// ---------------------------------------------------------------------------
// Config + token storage
// ---------------------------------------------------------------------------

function apiBase() {
  const env = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function realmId() {
  return (process.env.QBO_REALM_ID || '').replace(/\s+/g, '');
}

function basicAuthHeader() {
  const id = process.env.QBO_CLIENT_ID || '';
  const secret = process.env.QBO_CLIENT_SECRET || '';
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch (err) {
      console.error('[quickbooks] failed to read token file:', err.message);
    }
  }
  if (process.env.QBO_REFRESH_TOKEN) {
    return {
      access_token: process.env.QBO_ACCESS_TOKEN || null,
      refresh_token: process.env.QBO_REFRESH_TOKEN,
      expires_at: 0,
    };
  }
  return null;
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID || '',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI || '',
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.QBO_REDIRECT_URI || '',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO code exchange ${res.status}: ${text}`);
  }
  const json = await res.json();
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(currentRefreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO token refresh ${res.status}: ${text}`);
  }
  const json = await res.json();
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function ensureAccessToken() {
  let tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error(
      'Not connected to QuickBooks. Visit /api/qbo/connect to authorize.',
    );
  }
  if (!tokens.access_token || !tokens.expires_at || Date.now() >= tokens.expires_at) {
    tokens = await refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Report fetching + parsing
// ---------------------------------------------------------------------------

async function qboGet(reportPath, params = {}) {
  const token = await ensureAccessToken();
  const url = new URL(`${apiBase()}/v3/company/${realmId()}/${reportPath}`);
  url.searchParams.set('minorversion', '70');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO ${reportPath} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// QBO Report rows are deeply nested: Header/Rows/Row + Summary at each level.
// This walks the tree and invokes cb(row, depth, ancestorHeaders).
function walkRows(report, cb) {
  const visit = (rows, depth, ancestors) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const headerLabel = row.Header?.ColData?.[0]?.value || row.group || null;
      cb(row, depth, ancestors);
      const nested = row.Rows?.Row;
      if (nested && nested.length) {
        visit(nested, depth + 1, headerLabel ? [...ancestors, headerLabel] : ancestors);
      }
    }
  };
  visit(report?.Rows?.Row || [], 0, []);
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = parseFloat(String(value).replace(/[,$\s]/g, ''));
  return Number.isNaN(n) ? null : n;
}

function parseCash(balanceSheet) {
  // Find the "Bank Accounts" / "Cash" section. Detail rows under it have an
  // account name in ColData[0] and a balance in the last ColData entry.
  const bankBalances = [];
  let inBank = false;
  let depthEnteredBank = -1;
  walkRows(balanceSheet, (row, depth, ancestors) => {
    const ancestorStr = ancestors.join('|').toLowerCase();
    const headerStr = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
    if (headerStr.includes('bank account') || headerStr === 'cash') {
      inBank = true;
      depthEnteredBank = depth;
      return;
    }
    if (inBank && depth <= depthEnteredBank && !ancestorStr.includes('bank')) {
      inBank = false;
    }
    const isInBank =
      inBank ||
      ancestorStr.includes('bank') ||
      ancestorStr.includes('cash');
    if (isInBank && row.ColData) {
      const name = row.ColData[0]?.value;
      const amt = toNumber(row.ColData[row.ColData.length - 1]?.value);
      const isSummary = row.type === 'Section' || row.group;
      if (name && amt != null && !isSummary && row.ColData.length >= 2) {
        bankBalances.push({ account: name, balance: amt });
      }
    }
  });
  if (bankBalances.length === 0) return null;
  // Deduplicate (some reports double-count via summary rows)
  const uniq = new Map();
  bankBalances.forEach((b) => uniq.set(b.account, b));
  const list = [...uniq.values()];
  const total = list.reduce((s, b) => s + b.balance, 0);
  return { cashOnHand: Number(total.toFixed(2)), bankBalances: list };
}

function parseIncomeExpense(pnl) {
  // Look for Summary rows tagged "Total Income" and "Total Expenses".
  let income = null;
  let expenses = null;
  walkRows(pnl, (row) => {
    const label = (row.Summary?.ColData?.[0]?.value || row.group || '').toLowerCase();
    const amt = toNumber(row.Summary?.ColData?.[1]?.value);
    if (amt == null) return;
    if (label.includes('total income') || label === 'income') income = amt;
    if (label.includes('total expenses') || label === 'expenses') expenses = amt;
  });
  if (income == null && expenses == null) return null;
  return {
    monthlyIncome: income,
    monthlyExpenses: expenses,
    monthlyBurnRate:
      income != null && expenses != null ? Math.max(0, expenses - income) : null,
  };
}

function parseClassExpenses(pnlByClass) {
  // With summarize_column_by=Class, Columns[].ColTitle is the class name and
  // each Row has one Summary value per column. We extract the "Total Expenses"
  // summary row and split it by class.
  const cols = pnlByClass?.Columns?.Column || [];
  const classNames = cols.map((c) => c.ColTitle).filter(Boolean);
  if (classNames.length === 0) return null;

  let totalExpensesRow = null;
  walkRows(pnlByClass, (row) => {
    const label = (row.Summary?.ColData?.[0]?.value || row.group || '').toLowerCase();
    if (label.includes('total expenses') || label === 'expenses') {
      totalExpensesRow = row;
    }
  });
  if (!totalExpensesRow) return null;

  const cells = totalExpensesRow.Summary?.ColData || [];
  // cells[0] is the label; cells[1..N] correspond to classNames[0..N-1].
  return classNames
    .map((name, i) => {
      const amt = toNumber(cells[i + 1]?.value);
      if (!name || amt == null) return null;
      return {
        class: name,
        rehabSpend: amt, // TODO split rehab/holding/interest when account-detail mapping is added
        holdingCosts: null,
        interestPayments: null,
        totalSpend: amt,
      };
    })
    .filter(Boolean);
}

function parseAP(apReport) {
  // AgedPayables columns are: Vendor | Current | 1-30 | 31-60 | 61-90 | 91+ | Total
  const buckets = { current: 0, '1to30': 0, '31to60': 0, '61to90': 0, over90: 0 };
  let total = 0;
  let found = false;
  walkRows(apReport, (row) => {
    const label = (row.Summary?.ColData?.[0]?.value || '').toLowerCase();
    const cols = row.Summary?.ColData;
    if (!cols || !label.includes('total')) return;
    found = true;
    buckets.current = toNumber(cols[1]?.value) || 0;
    buckets['1to30'] = toNumber(cols[2]?.value) || 0;
    buckets['31to60'] = toNumber(cols[3]?.value) || 0;
    buckets['61to90'] = toNumber(cols[4]?.value) || 0;
    buckets.over90 = toNumber(cols[5]?.value) || 0;
    total = toNumber(cols[6]?.value) || 0;
  });
  if (!found) return null;
  return { apOutstanding: total, apAging: buckets };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function loadMock() {
  return JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
}

async function fetchLive() {
  if (!process.env.QBO_CLIENT_ID || !process.env.QBO_CLIENT_SECRET || !realmId()) {
    throw new Error('Missing QBO credentials in environment');
  }

  const [bs, pnl, pnlByClass, ap] = await Promise.all([
    qboGet('reports/BalanceSheet').catch((e) => {
      console.error('[quickbooks] BalanceSheet:', e.message);
      return null;
    }),
    qboGet('reports/ProfitAndLoss', { date_macro: 'This Month-to-date' }).catch(
      (e) => {
        console.error('[quickbooks] ProfitAndLoss:', e.message);
        return null;
      },
    ),
    qboGet('reports/ProfitAndLoss', {
      date_macro: 'This Year-to-date',
      summarize_column_by: 'Class',
    }).catch((e) => {
      console.error('[quickbooks] PnL-by-Class:', e.message);
      return null;
    }),
    qboGet('reports/AgedPayables').catch((e) => {
      console.error('[quickbooks] AgedPayables:', e.message);
      return null;
    }),
  ]);

  const mock = loadMock();
  const live = { ...mock, asOf: new Date().toISOString().slice(0, 10) };

  const cash = bs ? parseCash(bs) : null;
  if (cash) {
    live.cashOnHand = cash.cashOnHand;
    live.bankBalances = cash.bankBalances;
  }

  const ie = pnl ? parseIncomeExpense(pnl) : null;
  if (ie) {
    if (ie.monthlyIncome != null) live.monthlyIncome = ie.monthlyIncome;
    if (ie.monthlyExpenses != null) live.monthlyExpenses = ie.monthlyExpenses;
    if (ie.monthlyBurnRate != null) live.monthlyBurnRate = ie.monthlyBurnRate;
  }

  const classExpenses = pnlByClass ? parseClassExpenses(pnlByClass) : null;
  if (classExpenses && classExpenses.length) {
    live.classExpenses = classExpenses;
  }

  const apTotals = ap ? parseAP(ap) : null;
  if (apTotals) {
    live.apOutstanding = apTotals.apOutstanding;
    live.apAging = apTotals.apAging;
  }

  return live;
}

async function getFinancialSnapshot() {
  const mode = (process.env.DATA_MODE || 'mock').toLowerCase();
  const hasCreds =
    !!process.env.QBO_CLIENT_ID &&
    !!process.env.QBO_CLIENT_SECRET &&
    !!realmId();

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

async function connectionStatus() {
  const tokens = loadTokens();
  return {
    connected: !!(tokens && tokens.refresh_token),
    environment: (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase(),
    realmId: realmId() || null,
    hasClientCredentials:
      !!process.env.QBO_CLIENT_ID && !!process.env.QBO_CLIENT_SECRET,
    accessTokenExpiresAt: tokens?.expires_at
      ? new Date(tokens.expires_at).toISOString()
      : null,
  };
}

module.exports = {
  getFinancialSnapshot,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  connectionStatus,
};
