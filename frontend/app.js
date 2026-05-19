// We Flip Houses dashboard frontend.
// Vanilla JS — fetches /api/dashboard on load, on Refresh Now click, and on
// the auto-refresh interval returned by /api/config.

const $ = (id) => document.getElementById(id);

const state = {
  refreshTimer: null,
  refreshIntervalMs: 300000,
  targets: null,
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmtCurrency = (n) =>
  n == null || Number.isNaN(n)
    ? '—'
    : '$' + Math.round(n).toLocaleString();

const fmtNumber = (n) => (n == null ? '—' : n.toLocaleString());

const fmtPct = (n) => (n == null ? '—' : `${n}%`);

const fmtDate = (s) => (s ? s : '—');

const riskPill = (status) =>
  `<span class="pill ${(status || '').toLowerCase()}">${status || '—'}</span>`;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderSummary(d) {
  const s = d.executiveSummary;
  const cashClass =
    s.cashOnHand < s.targets.minimumCashReserveWarning ? 'card-bad' : 'card-good';

  const cards = [
    { label: 'Cash on Hand', value: fmtCurrency(s.cashOnHand), klass: cashClass },
    { label: 'Active Projects', value: fmtNumber(s.activeProjects) },
    {
      label: 'Properties at Risk',
      value: fmtNumber(s.propertiesAtRisk),
      klass: s.propertiesAtRisk > 0 ? 'card-bad' : 'card-good',
    },
    {
      label: 'Offers This Week',
      value: fmtNumber(s.offersMadeThisWeek),
      sub: `target ${s.targets.weeklyOfferTarget}`,
      klass: s.offersMadeThisWeek >= s.targets.weeklyOfferTarget ? 'card-good' : 'card-warn',
    },
    {
      label: 'Contracts This Month',
      value: fmtNumber(s.contractsSignedThisMonth),
      sub: `target ${s.targets.monthlyContractTarget}`,
      klass:
        s.contractsSignedThisMonth >= s.targets.monthlyContractTarget
          ? 'card-good'
          : 'card-warn',
    },
    { label: 'Expected Profit (Next 90d)', value: fmtCurrency(s.expectedProfitNext90Days) },
    { label: 'Monthly Burn', value: fmtCurrency(s.monthlyBurn) },
    { label: 'Avg Days in Rehab', value: fmtNumber(s.avgDaysInRehab) },
  ];

  $('summaryCards').innerHTML = cards
    .map(
      (c) => `
      <div class="card">
        <div class="card-label">${c.label}</div>
        <div class="card-value ${c.klass || ''}">${c.value}</div>
        ${c.sub ? `<div class="card-sub">${c.sub}</div>` : ''}
      </div>`,
    )
    .join('');

  renderFiveQuestions(d);
}

function renderFiveQuestions(d) {
  const t = d.executiveSummary.targets;
  const acq = d.acquisitions;
  const dailyMoved = d.projects.filter(
    (p) => p.emptyDays != null && p.emptyDays <= 1,
  ).length;
  const totalActive = d.projects.length;
  const cashHealthy = d.executiveSummary.cashOnHand >= t.minimumCashReserveWarning;

  const oldestInventory = d.inventoryAging[0];
  const trappedCash = d.inventoryAging.reduce(
    (s, p) => s + (p.equityTrapped || 0),
    0,
  );

  const items = [
    {
      q: '1. Are leads being generated?',
      a: `${acq.weekly.newLeads} leads this week`,
      status:
        acq.weekly.newLeads >= t.weeklyLeadTarget
          ? 'green'
          : acq.weekly.newLeads >= t.weeklyLeadTarget * 0.7
            ? 'yellow'
            : 'red',
      detail: `Target: ${t.weeklyLeadTarget}/wk`,
    },
    {
      q: '2. Are offers being made?',
      a: `${acq.weekly.offersMade} offers this week`,
      status:
        acq.weekly.offersMade >= t.weeklyOfferTarget
          ? 'green'
          : acq.weekly.offersMade >= t.weeklyOfferTarget * 0.6
            ? 'yellow'
            : 'red',
      detail: `Target: ${t.weeklyOfferTarget}/wk`,
    },
    {
      q: '3. Are projects moving daily?',
      a: `${dailyMoved} of ${totalActive} updated today`,
      status:
        totalActive === 0
          ? 'green'
          : dailyMoved / totalActive >= 0.7
            ? 'green'
            : dailyMoved / totalActive >= 0.4
              ? 'yellow'
              : 'red',
      detail: 'Updates within last day',
    },
    {
      q: '4. Is cash trapped in aging inventory?',
      a: fmtCurrency(trappedCash),
      status:
        trappedCash > t.minimumCashReserveWarning
          ? 'yellow'
          : 'green',
      detail: oldestInventory
        ? `Oldest: ${oldestInventory.address} (${oldestInventory.daysOwned}d)`
        : '',
    },
    {
      q: '5. What properties are at risk?',
      a: `${d.executiveSummary.propertiesAtRisk} red`,
      status: d.executiveSummary.propertiesAtRisk > 0 ? 'red' : 'green',
      detail: cashHealthy ? 'Cash reserves healthy' : 'Cash below warning threshold',
    },
  ];

  $('fiveQuestions').innerHTML = items
    .map(
      (i) => `
      <div class="fq ${i.status}">
        <div class="fq-q">${i.q}</div>
        <div class="fq-a">${i.a}</div>
        <div class="fq-detail">${i.detail}</div>
      </div>`,
    )
    .join('');
}

function renderAcquisitions(d) {
  const acq = d.acquisitions;
  const funnelRows = (f) => `
    <tr><th>Stage</th><th>Count</th></tr>
    <tr><td>New Leads</td><td>${f.newLeads}</td></tr>
    <tr><td>Qualified</td><td>${f.qualifiedLeads}</td></tr>
    <tr><td>Appointments</td><td>${f.appointments}</td></tr>
    <tr><td>Offers Made</td><td>${f.offersMade}</td></tr>
    <tr><td>Contracts Signed</td><td>${f.contractsSigned}</td></tr>
  `;
  $('weeklyFunnel').innerHTML = funnelRows(acq.weekly);
  $('monthlyFunnel').innerHTML = funnelRows(acq.monthly);

  $('acqRatios').innerHTML = [
    {
      label: 'Offer → Contract Ratio (wk)',
      value: acq.offerToContractRatio == null ? '—' : (acq.offerToContractRatio * 100).toFixed(0) + '%',
    },
    { label: 'Cost per Lead (mo)', value: fmtCurrency(acq.costPerLead) },
    { label: 'Cost per Contract (mo)', value: fmtCurrency(acq.costPerContract) },
    { label: 'Marketing Spend (mo)', value: fmtCurrency(acq.marketingSpendMonthly) },
  ]
    .map(
      (c) => `
      <div class="card">
        <div class="card-label">${c.label}</div>
        <div class="card-value">${c.value}</div>
      </div>`,
    )
    .join('');

  $('leadSources').innerHTML = `
    <thead>
      <tr>
        <th>Source</th><th>New Leads</th><th>Qualified</th><th>Contracts</th>
        <th>Spend</th><th>$ / Lead</th><th>$ / Contract</th>
      </tr>
    </thead>
    <tbody>
      ${acq.leadSources
        .map(
          (s) => `
          <tr>
            <td>${s.source}</td>
            <td>${s.newLeads}</td>
            <td>${s.qualifiedLeads}</td>
            <td>${s.contracts}</td>
            <td>${fmtCurrency(s.spend)}</td>
            <td>${fmtCurrency(s.costPerLead)}</td>
            <td>${s.costPerContract == null ? '—' : fmtCurrency(s.costPerContract)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>`;

  $('pipeline').innerHTML = `
    <thead>
      <tr>
        <th>Lead ID</th><th>Address</th><th>City</th><th>Source</th>
        <th>Stage</th><th>Assigned</th><th>Offer</th><th>Last Touch</th>
      </tr>
    </thead>
    <tbody>
      ${acq.pipeline
        .map(
          (p) => `
          <tr>
            <td>${p.leadId}</td>
            <td>${p.address}</td>
            <td>${p.city}</td>
            <td>${p.source}</td>
            <td>${p.stage}</td>
            <td>${p.assignedTo}</td>
            <td>${p.offerAmount == null ? '—' : fmtCurrency(p.offerAmount)}</td>
            <td>${fmtDate(p.lastTouch)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>`;
}

function renderProjects(d) {
  $('projectsTable').innerHTML = `
    <thead>
      <tr>
        <th>Property</th><th>Phase</th><th>Owned</th><th>In Rehab</th>
        <th>Target</th><th>Budget vs Actual</th><th>%</th>
        <th>Last Update</th><th>Empty Days</th><th>PM</th>
        <th>Risk</th><th>Next Action</th>
      </tr>
    </thead>
    <tbody>
      ${d.projects
        .map((p) => {
          const overagePct =
            p.estimatedRehabBudget > 0
              ? (((p.actualRehabSpend - p.estimatedRehabBudget) / p.estimatedRehabBudget) * 100).toFixed(1)
              : '0.0';
          const overageNote =
            p.actualRehabSpend > p.estimatedRehabBudget
              ? ` <span class="card-bad">(+${overagePct}%)</span>`
              : '';
          return `
          <tr title="${(p.riskReasons || []).join(' | ')}">
            <td>${p.address}<div class="muted">${p.propertyId}</div></td>
            <td>${p.phase}</td>
            <td>${fmtNumber(p.daysOwned)}</td>
            <td>${fmtNumber(p.daysInRehab)}</td>
            <td>${fmtDate(p.targetCompletionDate)}</td>
            <td>${fmtCurrency(p.actualRehabSpend)} / ${fmtCurrency(p.estimatedRehabBudget)}${overageNote}</td>
            <td>${fmtPct(p.percentComplete)}</td>
            <td>${fmtDate(p.lastProjectUpdate)}</td>
            <td>${fmtNumber(p.emptyDays)}</td>
            <td>${p.projectManager || '—'}</td>
            <td>${riskPill(p.riskStatus)}</td>
            <td>${p.nextAction || '—'}</td>
          </tr>`;
        })
        .join('')}
    </tbody>`;
}

function renderInventory(d) {
  $('inventoryTable').innerHTML = `
    <thead>
      <tr>
        <th>Property</th><th>Purchased</th><th>Days Owned</th><th>Phase</th>
        <th>ARV</th><th>Equity Trapped</th><th>Daily Carry</th>
        <th>Carry to Date</th><th>Risk</th>
      </tr>
    </thead>
    <tbody>
      ${d.inventoryAging
        .map(
          (p) => `
          <tr>
            <td>${p.address}<div class="muted">${p.propertyId}</div></td>
            <td>${fmtDate(p.purchaseDate)}</td>
            <td>${fmtNumber(p.daysOwned)}</td>
            <td>${p.phase}</td>
            <td>${fmtCurrency(p.arv)}</td>
            <td>${fmtCurrency(p.equityTrapped)}</td>
            <td>${fmtCurrency(p.dailyCarryingCost)}</td>
            <td>${fmtCurrency(p.totalCarryingCostToDate)}</td>
            <td>${riskPill(p.riskStatus)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>`;
}

function renderCash(d) {
  const c = d.cashAndCarrying;
  $('cashCards').innerHTML = [
    { label: 'Cash Reserves', value: fmtCurrency(c.cashReserves) },
    { label: 'Monthly Overhead', value: fmtCurrency(c.monthlyOverhead) },
    { label: 'Interest Due (mo)', value: fmtCurrency(c.interestPaymentsDueThisMonth) },
    {
      label: 'Upcoming Investor Draws',
      value: fmtCurrency(
        (c.upcomingInvestorDraws || []).reduce((s, x) => s + x.amount, 0),
      ),
    },
  ]
    .map(
      (x) => `
      <div class="card">
        <div class="card-label">${x.label}</div>
        <div class="card-value">${x.value}</div>
      </div>`,
    )
    .join('');

  $('drawsTable').innerHTML = `
    <thead><tr><th>Investor</th><th>Amount</th><th>Due</th></tr></thead>
    <tbody>
      ${(c.upcomingInvestorDraws || [])
        .map(
          (x) =>
            `<tr><td>${x.investor}</td><td>${fmtCurrency(x.amount)}</td><td>${fmtDate(x.dueDate)}</td></tr>`,
        )
        .join('')}
    </tbody>`;

  $('carryingTable').innerHTML = `
    <thead>
      <tr><th>Property</th><th>Daily Carry</th><th>Days Owned</th><th>Total Carry</th></tr>
    </thead>
    <tbody>
      ${c.highestCarryingCostProperties
        .map(
          (p) => `
          <tr>
            <td>${p.address}<div class="muted">${p.propertyId}</div></td>
            <td>${fmtCurrency(p.dailyCarryingCost)}</td>
            <td>${fmtNumber(p.daysOwned)}</td>
            <td>${fmtCurrency(p.totalCarryingCostToDate)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>`;

  $('forecastTable').innerHTML = `
    <thead><tr><th>Horizon</th><th>Projected Cash</th></tr></thead>
    <tbody>
      ${c.forecast
        .map(
          (f) => `
          <tr>
            <td>${f.horizonDays} days</td>
            <td class="${f.projectedCash < 0 ? 'card-bad' : ''}">${fmtCurrency(f.projectedCash)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>`;
}

function renderProfit(d) {
  const p = d.profitForecast;
  $('profitCards').innerHTML = [
    { label: 'Next 30 Days', value: fmtCurrency(p.next30Days) },
    { label: 'Next 60 Days', value: fmtCurrency(p.next60Days) },
    { label: 'Next 90 Days', value: fmtCurrency(p.next90Days) },
    { label: 'Total Pipeline', value: fmtCurrency(p.totalPipelineProfit) },
  ]
    .map(
      (x) => `
      <div class="card">
        <div class="card-label">${x.label}</div>
        <div class="card-value">${x.value}</div>
      </div>`,
    )
    .join('');

  $('profitTable').innerHTML = `
    <thead>
      <tr>
        <th>Property</th><th>Projected Gross</th><th>Projected Net</th><th>Expected Sale</th>
      </tr>
    </thead>
    <tbody>
      ${p.byProject
        .map(
          (x) => `
          <tr>
            <td>${x.address}<div class="muted">${x.propertyId}</div></td>
            <td>${fmtCurrency(x.projectedGrossProfit)}</td>
            <td>${fmtCurrency(x.projectedNetProfit)}</td>
            <td>${fmtDate(x.expectedSaleDate)}</td>
          </tr>`,
        )
        .join('')}
    </tbody>`;
}

function renderAlerts(d) {
  const root = $('alertsList');
  if (!d.alerts.length) {
    root.innerHTML = `<div class="alert-empty">No active alerts. All systems green.</div>`;
    return;
  }
  root.innerHTML = d.alerts
    .map(
      (a) => `
      <div class="alert ${a.severity.toLowerCase()}">
        <span class="pill ${a.severity.toLowerCase()}">${a.severity}</span>
        <span class="alert-category">${a.category}</span>
        <span>${a.message}</span>
      </div>`,
    )
    .join('');
}

function renderV2Placeholders(flipTimer, homestead) {
  $('flipTimerPlaceholder').innerHTML = `
    <p>${flipTimer.message}</p>
    <h3>Sample schema</h3>
    <pre>${JSON.stringify(flipTimer.sampleSchema, null, 2)}</pre>`;
  $('homesteadPlaceholder').innerHTML = `
    <p>${homestead.message}</p>
    <h3>Sample schema</h3>
    <pre>${JSON.stringify(homestead.sampleSchema, null, 2)}</pre>`;
}

function renderSettings(targets) {
  state.targets = targets;
  const labels = {
    annualFlipTarget: 'Annual Flip Target',
    weeklyOfferTarget: 'Weekly Offer Target',
    monthlyContractTarget: 'Monthly Contract Target',
    weeklyLeadTarget: 'Weekly Lead Target',
    targetAverageNetProfitPerFlip: 'Target Avg Net Profit / Flip ($)',
    assignmentFeeTargetPerDeal: 'Assignment Fee Target / Deal ($)',
    monthlyOverhead: 'Monthly Overhead ($)',
    minimumCashReserveWarning: 'Min Cash Reserve Warning ($)',
    redAlertNoUpdateDays: 'Red Alert: No-update Days',
    yellowAlertNoUpdateDays: 'Yellow Alert: No-update Days',
    targetAverageRehabDurationDays: 'Target Avg Rehab Duration (days)',
    overBudgetRedPct: 'Red Alert: Over-budget %',
    overBudgetYellowPct: 'Yellow Alert: Over-budget %',
    maxDaysOwnedBeforeAlert: 'Max Days Owned Before Alert',
  };
  $('targetsForm').innerHTML = Object.keys(labels)
    .map(
      (k) => `
      <label>
        <span>${labels[k]}</span>
        <input type="number" name="${k}" value="${targets[k] ?? ''}" />
      </label>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadDashboard() {
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    $('dataMode').textContent =
      `qbo:${data.sources.quickbooks} · ff:${data.sources.flipperforce} · re:${data.sources.resimpli}`;
    $('lastUpdated').textContent = new Date(data.generatedAt).toLocaleTimeString();

    renderSummary(data);
    renderAcquisitions(data);
    renderProjects(data);
    renderInventory(data);
    renderCash(data);
    renderProfit(data);
    renderAlerts(data);

    $('footerNote').textContent = `Generated at ${new Date(data.generatedAt).toLocaleString()} · ${data.unifiedProperties.length} unified property records`;
  } catch (err) {
    console.error('Dashboard load failed', err);
    $('lastUpdated').textContent = 'load failed';
    $('alertsList').innerHTML = `<div class="alert red"><span class="pill red">Red</span><span>Dashboard load failed: ${err.message}</span></div>`;
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    state.refreshIntervalMs = cfg.refreshIntervalMs;
    renderSettings(cfg.targets);
    $('brandName').textContent = cfg.targets.company?.name || 'We Flip Houses';
    $('brandTagline').textContent =
      cfg.targets.company?.tagline || 'Executive Operating Cockpit';
  } catch (err) {
    console.error('Config load failed', err);
  }
}

async function loadV2() {
  try {
    const [ft, hh] = await Promise.all([
      fetch('/api/v2/flip-timer').then((r) => r.json()),
      fetch('/api/v2/homestead-hill').then((r) => r.json()),
    ]);
    renderV2Placeholders(ft, hh);
  } catch (err) {
    console.error('V2 load failed', err);
  }
}

async function saveTargets() {
  const form = $('targetsForm');
  const body = {};
  Array.from(form.querySelectorAll('input')).forEach((input) => {
    const val = Number(input.value);
    if (!Number.isNaN(val)) body[input.name] = val;
  });
  try {
    const res = await fetch('/api/config/targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || 'save failed');
    $('settingsStatus').textContent = 'Saved. Next refresh will use new targets.';
    state.targets = result.targets;
    loadDashboard();
  } catch (err) {
    $('settingsStatus').textContent = `Save failed: ${err.message}`;
  }
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadDashboard, state.refreshIntervalMs);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  $('refreshBtn').addEventListener('click', loadDashboard);
  $('saveTargetsBtn').addEventListener('click', saveTargets);
  await loadConfig();
  await Promise.all([loadDashboard(), loadV2()]);
  startAutoRefresh();
});
