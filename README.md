# We Flip Houses — Executive Operating Cockpit

An internal real-estate-investing dashboard for **We Flip Houses**. Pulls and
normalizes data from QuickBooks Online, FlipperForce, and REsimpli into one
executive view designed to answer the same five questions every morning:

1. Are leads being generated?
2. Are offers being made?
3. Are projects moving daily?
4. Is cash trapped in aging inventory?
5. What properties are at risk?

The app is local-first, ships with realistic mock data so it runs end-to-end
without any credentials, and is structured so V2 can add the Flip Timer App
and Homestead Hill Tracker without rework.

---

## Quick start

```bash
git clone <this repo>
cd wefliphouses-os
cp .env.example .env       # all defaults work in mock mode
npm install
npm start
```

Then open <http://localhost:3000>.

You should see live mock data, the five-question morning panel, an alerts
stack, and tabs for Acquisitions / Projects / Inventory / Cash / Profit /
Settings, plus disabled V2 tabs.

---

## Architecture

```
/backend
  server.js                       Express app + dashboard aggregator
  /services
    quickbooksService.js          QBO wrapper (mock + TODO live)
    flipperforceService.js        FlipperForce wrapper (mock + TODO live)
    resimpliService.js            REsimpli wrapper (mock + TODO live)
    normalizationService.js       Merges sources into the unified model
    riskScoringService.js         Red / Yellow / Green rules
    flipTimerService.js           V2 placeholder
    homesteadHillService.js       V2 placeholder
  /data
    mockQuickBooks.json
    mockFlipperForce.json
    mockREsimpli.json
  /config
    businessTargets.json
/frontend
  index.html
  styles.css
  app.js
.env.example
README.md
```

Each service exposes `getX()` that returns
`{ source: 'mock' | 'live', data, error? }`. The server fetches all three in
parallel; if one fails the dashboard still renders the rest and surfaces a
"Missing data from <source>" alert.

---

## Unified property/deal model

All three sources are normalized into one record per property by
`normalizationService.js`. The join key is **QBO Class name === FlipperForce
projectId** — operators must keep these in sync when creating a new flip.

```js
{
  propertyId, address, city, acquisitionSource, leadSource,
  purchaseDate, contractDate, closeDate, rehabStartDate,
  targetCompletionDate, listDate, saleDate,
  status, phase,
  arv, purchasePrice, estimatedRehabBudget, actualRehabSpend,
  estimatedHoldingCosts, actualHoldingCosts, dailyCarryingCost,
  projectedGrossProfit, projectedNetProfit, actualNetProfit,
  projectManager, acquisitionsManager,
  lastProjectUpdate, emptyDays, nextAction, blockers,
  riskStatus, riskReasons,
  daysOwned, daysInRehab, percentComplete, interestPayments,
}
```

Any field that isn't derivable from current sources is `null`; the UI shows
`—` and the field is ready to populate when the API is wired up.

---

## Risk scoring

Implemented in `riskScoringService.js`. Returns the worst applicable status:

| Condition                                       | Status |
| ----------------------------------------------- | ------ |
| No update in ≥ 3 days *(configurable)*          | Red    |
| Over rehab budget by ≥ 10% *(configurable)*     | Red    |
| Past target completion date                     | Red    |
| No update in ≥ 2 days *(configurable)*          | Yellow |
| Over rehab budget by ≥ 5% *(configurable)*      | Yellow |
| Owned ≥ 180 days *(configurable)*               | Yellow |
| Has a recorded blocker                          | Yellow |
| Otherwise                                       | Green  |

All thresholds live in `backend/config/businessTargets.json` and are editable
from the **Settings** tab in the UI.

---

## Auto refresh

* Backend exposes the configured interval via `GET /api/config`.
* Frontend reads it on boot and `setInterval`s `GET /api/dashboard`.
* Default is **5 minutes**, configurable via `REFRESH_INTERVAL_MS` in `.env`
  (the brief allows 5–15 minutes).
* The header has a **Refresh Now** button for manual pulls.

---

## API endpoints

| Method | Path                       | Purpose                                       |
| ------ | -------------------------- | --------------------------------------------- |
| GET    | `/api/health`              | Liveness                                      |
| GET    | `/api/config`              | Returns targets + refresh interval + mode     |
| PUT    | `/api/config/targets`      | Updates `businessTargets.json` (JSON body)    |
| GET    | `/api/dashboard`           | Single aggregated payload for the UI          |
| GET    | `/api/v2/flip-timer`       | V2 placeholder                                |
| GET    | `/api/v2/homestead-hill`   | V2 placeholder                                |

---

## Wiring real APIs

Set `DATA_MODE=live` in `.env`, then fill in credentials and implement the
`fetchLive()` function in each service.

### QuickBooks Online
Implemented. Live mode pulls four reports in parallel and maps them into
the same shape as `mockQuickBooks.json` so the rest of the app is unchanged.

**One-time connect flow:**
1. In the Intuit developer dashboard, set the app's Redirect URI to exactly
   `http://localhost:3000/api/qbo/callback` (or whatever you set
   `QBO_REDIRECT_URI` to).
2. Fill in `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`,
   `QBO_ENVIRONMENT` in `.env`. Set `DATA_MODE=live`.
3. `npm start`, then visit <http://localhost:3000/api/qbo/connect> and
   authorize the WFH company.
4. Tokens are persisted to `backend/data/qbo_tokens.json` (gitignored) and
   auto-refresh. The dashboard's QBO source pill flips to `live` on next
   refresh. `GET /api/qbo/status` shows current connection state.

**Reports used:**
* `BalanceSheet` — cash on hand, bank balances
* `ProfitAndLoss` (this month-to-date) — monthly income, expenses, burn
* `ProfitAndLoss` (summarize_column_by=Class) — per-property class expenses
* `AgedPayables` — AP outstanding + aging buckets

**Required convention:** create one QBO **Class** per flip whose name
exactly matches the FlipperForce **projectId**. The class-summary report
columns are matched to projects on this join.

### FlipperForce
FlipperForce does not publish a public REST API as of 2026-05. Three paths:
1. **CSV drop (zero-config):** export Projects to CSV, place at
   `backend/data/flipperforce_export.csv`. The service auto-detects it and
   parses headers like `projectId`, `address`, `Budgeted Rehab`, etc. (see
   `csvRowToProject` in `flipperforceService.js` for the full mapping).
2. **Partner / private API:** set `FLIPPERFORCE_API_BASE` and
   `FLIPPERFORCE_API_KEY`, then start the app and visit
   <http://localhost:3000/api/flipperforce/probe>. It will try five auth
   header styles (`Bearer`, `X-API-Key`, `Api-Token`, `Token`, cookie) +
   query-string mode against five common paths, and report which (if any)
   returns 200. Set `FLIPPERFORCE_AUTH_MODE` and `FLIPPERFORCE_PROJECTS_PATH`
   accordingly.
3. **Webhook ingest:** push project updates from FlipperForce via Zapier or
   Make into a local file/store and have `flipperforceService` read from it.

The Laravel-encrypted (`Crypt::encryptString`) format of the key in
FlipperForce settings suggests their backend decrypts server-side; until we
have docs, the probe is the cleanest way to discover the right wire format.

### REsimpli
REsimpli does not publish a public API spec. Same pattern as FlipperForce:
1. Set `RESIMPLI_API_KEY` in `.env`.
2. Start the app and visit <http://localhost:3000/api/resimpli/probe>. It
   tries four auth header styles + query-string mode against four base URLs
   × five common paths and reports which combination returns 200.
3. Lock in `RESIMPLI_API_BASE`, `RESIMPLI_LEADS_PATH`, and
   `RESIMPLI_AUTH_MODE` from the probe results.

`fetchLive()` maps the leads array into weekly/monthly funnel counts
(new / qualified / appt / offer / contract) by date-bucketing leads on
`createdAt` / `updatedAt`. Lead-source ROI and marketing spend stay as mock
until the marketing endpoint shape is confirmed.

---

## Credentials & docs you still need to provide

To move from mock mode to live mode, gather:

1. **QuickBooks Online**
   * Intuit developer app `Client ID` and `Client Secret`
   * `Realm ID` (company ID) and a `Refresh Token` for the WFH company file
   * Confirmation that all flip-related expenses are tagged with a `Class`
     matching the project ID
2. **FlipperForce**
   * Confirmation of whether a partner API is available
   * Otherwise: documented CSV export schema, or willingness to set up
     Zapier/Make webhooks
3. **REsimpli**
   * API key + documentation of endpoints for leads / pipeline / marketing
     spend
4. **General**
   * Confirmation of the canonical property ID convention across systems
   * Mapping of REsimpli lead sources to expected QBO classes if you want
     attribution
5. **V2 (not blocking V1)**
   * Flip Timer App: API spec or webhook contract
   * Homestead Hill Tracker: data source (PMS export, Hostfully API, etc.)

---

## Settings (business targets)

Edit `backend/config/businessTargets.json` or use the **Settings** tab. All
fields are picked up on the next `/api/dashboard` request.

| Key                              | Default  | Used in                       |
| -------------------------------- | -------- | ----------------------------- |
| `annualFlipTarget`               | 36       | Future capacity widget        |
| `weeklyOfferTarget`              | 5        | Five-question + alerts        |
| `monthlyContractTarget`          | 3        | Summary card                  |
| `weeklyLeadTarget`               | 25       | Five-question + alerts        |
| `targetAverageNetProfitPerFlip`  | 40000    | Forecast comparisons          |
| `assignmentFeeTargetPerDeal`     | 10000    | Reserved                      |
| `monthlyOverhead`                | 60000    | Cash forecast                 |
| `minimumCashReserveWarning`      | 500000   | Summary + alerts              |
| `redAlertNoUpdateDays`           | 3        | Risk scoring                  |
| `yellowAlertNoUpdateDays`        | 2        | Risk scoring                  |
| `targetAverageRehabDurationDays` | 75       | Reserved                      |
| `overBudgetRedPct`               | 10       | Risk scoring                  |
| `overBudgetYellowPct`            | 5        | Risk scoring                  |
| `maxDaysOwnedBeforeAlert`        | 180      | Inventory aging alert         |

---

## V2 roadmap

Two scaffolded tabs return `{ enabled: false }` today:

* **Flip Timer App** — days owned, days in phase, daily holding cost,
  urgency score. Wire `flipTimerService.getFlipTimerState()` and flip
  `enabled: true`; the existing tab will pick it up.
* **Homestead Hill Tracker** — STR revenue, occupancy, unit status,
  maintenance, monthly NOI, DSCR. Same pattern.

V1 deliberately does no work for V2 beyond these stubs.

---

## Troubleshooting

* **Dashboard loads but says "qbo:mock · ff:mock · re:mock"** — that's
  expected until you set `DATA_MODE=live` and provide credentials.
* **A live API fails after wiring** — the data-source pill will still say
  `mock` (auto fallback), and a yellow alert appears in the Alerts tab.
  Backend logs show `[service] live fetch failed, using mock: <reason>`.
* **Risk seems wrong** — every row's `<tr title>` shows the rules that fired
  on hover; tweak thresholds in Settings.
