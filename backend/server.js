/**
 * We Flip Houses — Executive Dashboard backend.
 *
 * Single responsibility: aggregate QBO + FlipperForce + REsimpli into one
 * /api/dashboard payload that the frontend renders. Each source is fetched
 * independently so one failing API never blanks the dashboard.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');

const quickbooks = require('./services/quickbooksService');
const flipperforce = require('./services/flipperforceService');
const resimpli = require('./services/resimpliService');
const normalization = require('./services/normalizationService');
const riskScoring = require('./services/riskScoringService');
const flipTimer = require('./services/flipTimerService');
const homesteadHill = require('./services/homesteadHillService');

const TARGETS_PATH = path.join(__dirname, 'config', 'businessTargets.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS, 10) || 300000;

app.use(express.json());
app.use(express.static(FRONTEND_DIR));

function loadTargets() {
  return JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

function buildExecutiveSummary({ qbo, properties, resimpliData, targets }) {
  const activeProjects = properties.filter((p) => p.status !== 'Sold').length;
  const propertiesAtRisk = properties.filter((p) => p.riskStatus === 'Red').length;

  const rehabDurations = properties
    .filter((p) => p.daysInRehab != null && p.status === 'Rehab')
    .map((p) => p.daysInRehab);
  const avgDaysInRehab =
    rehabDurations.length === 0
      ? 0
      : Math.round(rehabDurations.reduce((a, b) => a + b, 0) / rehabDurations.length);

  const expectedProfitNext90 = properties
    .filter((p) => {
      if (!p.targetCompletionDate) return false;
      const target = new Date(p.targetCompletionDate);
      const now = new Date();
      const ninety = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      return target <= ninety && p.status !== 'Sold';
    })
    .reduce((sum, p) => sum + (p.projectedNetProfit || 0), 0);

  return {
    cashOnHand: qbo.cashOnHand,
    activeProjects,
    propertiesAtRisk,
    offersMadeThisWeek: resimpliData.weekly.offersMade,
    contractsSignedThisMonth: resimpliData.monthly.contractsSigned,
    expectedProfitNext90Days: expectedProfitNext90,
    monthlyBurn: qbo.monthlyBurnRate,
    avgDaysInRehab,
    targets,
  };
}

function buildAcquisitions(resimpliData) {
  const { weekly, monthly, leadSources, marketingSpendMonthly, pipeline } = resimpliData;
  const offerToContractRatio =
    weekly.offersMade === 0
      ? 0
      : Number((weekly.contractsSigned / weekly.offersMade).toFixed(2));
  const totalLeadsMonth = monthly.newLeads || 0;
  const totalContractsMonth = monthly.contractsSigned || 0;
  const costPerLead =
    totalLeadsMonth === 0
      ? null
      : Number((marketingSpendMonthly / totalLeadsMonth).toFixed(2));
  const costPerContract =
    totalContractsMonth === 0
      ? null
      : Number((marketingSpendMonthly / totalContractsMonth).toFixed(2));

  return {
    weekly,
    monthly,
    offerToContractRatio,
    costPerLead,
    costPerContract,
    marketingSpendMonthly,
    leadSources,
    pipeline,
  };
}

function buildInventoryAging(properties) {
  return properties
    .filter((p) => p.status !== 'Sold')
    .map((p) => {
      const equityTrapped =
        p.arv != null && p.purchasePrice != null && p.actualRehabSpend != null
          ? p.arv - p.purchasePrice - p.actualRehabSpend
          : null;
      const totalCarryingCostToDate =
        p.dailyCarryingCost != null && p.daysOwned != null
          ? Math.round(p.dailyCarryingCost * p.daysOwned)
          : null;
      return {
        propertyId: p.propertyId,
        address: p.address,
        purchaseDate: p.purchaseDate,
        daysOwned: p.daysOwned,
        phase: p.phase,
        arv: p.arv,
        equityTrapped,
        dailyCarryingCost: p.dailyCarryingCost,
        totalCarryingCostToDate,
        riskStatus: p.riskStatus,
      };
    })
    .sort((a, b) => (b.daysOwned || 0) - (a.daysOwned || 0));
}

function buildCashAndCarrying({ qbo, properties, targets }) {
  const highestCarrying = [...properties]
    .filter((p) => p.dailyCarryingCost && p.daysOwned)
    .sort(
      (a, b) =>
        b.dailyCarryingCost * b.daysOwned - a.dailyCarryingCost * a.daysOwned,
    )
    .slice(0, 5)
    .map((p) => ({
      propertyId: p.propertyId,
      address: p.address,
      totalCarryingCostToDate: Math.round(p.dailyCarryingCost * p.daysOwned),
      dailyCarryingCost: p.dailyCarryingCost,
      daysOwned: p.daysOwned,
    }));

  // Very simple 30/60/90 cash forecast: starting cash minus (overhead + draws +
  // interest) over the period, plus expected net profits whose targets fall in.
  const overheadPerDay = targets.monthlyOverhead / 30;
  const drawTotal = (qbo.upcomingInvestorDraws || []).reduce(
    (s, d) => s + d.amount,
    0,
  );

  const forecast = [30, 60, 90].map((days) => {
    const profitInWindow = properties
      .filter((p) => {
        if (!p.targetCompletionDate || p.status === 'Sold') return false;
        const t = new Date(p.targetCompletionDate);
        const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        return t <= end;
      })
      .reduce((s, p) => s + (p.projectedNetProfit || 0), 0);

    const projectedCash =
      qbo.cashOnHand -
      overheadPerDay * days -
      qbo.interestPaymentsDueThisMonth * (days / 30) -
      drawTotal +
      profitInWindow;
    return { horizonDays: days, projectedCash: Math.round(projectedCash) };
  });

  return {
    monthlyOverhead: targets.monthlyOverhead,
    cashReserves: qbo.cashOnHand,
    upcomingInvestorDraws: qbo.upcomingInvestorDraws,
    interestPaymentsDueThisMonth: qbo.interestPaymentsDueThisMonth,
    highestCarryingCostProperties: highestCarrying,
    forecast,
  };
}

function buildProfitForecast(properties) {
  const byProject = properties
    .filter((p) => p.status !== 'Sold')
    .map((p) => ({
      propertyId: p.propertyId,
      address: p.address,
      projectedGrossProfit: p.projectedGrossProfit,
      projectedNetProfit: p.projectedNetProfit,
      expectedSaleDate: p.targetCompletionDate, // V1 approximation
    }));

  const horizon = (days) =>
    byProject
      .filter((p) => {
        if (!p.expectedSaleDate) return false;
        return new Date(p.expectedSaleDate) <= new Date(Date.now() + days * 86400000);
      })
      .reduce((s, p) => s + (p.projectedNetProfit || 0), 0);

  return {
    byProject,
    next30Days: horizon(30),
    next60Days: horizon(60),
    next90Days: horizon(90),
    totalPipelineProfit: byProject.reduce(
      (s, p) => s + (p.projectedNetProfit || 0),
      0,
    ),
  };
}

function buildAlerts({ qbo, properties, resimpliData, targets, sourceErrors }) {
  const alerts = [];

  properties.forEach((p) => {
    if (p.emptyDays != null && p.emptyDays >= targets.yellowAlertNoUpdateDays) {
      alerts.push({
        severity: p.emptyDays >= targets.redAlertNoUpdateDays ? 'Red' : 'Yellow',
        category: 'Project Update',
        message: `${p.address}: no update in ${p.emptyDays} day(s)`,
      });
    }
    const overagePct =
      p.estimatedRehabBudget && p.estimatedRehabBudget > 0
        ? ((p.actualRehabSpend - p.estimatedRehabBudget) / p.estimatedRehabBudget) * 100
        : 0;
    if (overagePct >= targets.overBudgetYellowPct) {
      alerts.push({
        severity: overagePct >= targets.overBudgetRedPct ? 'Red' : 'Yellow',
        category: 'Budget',
        message: `${p.address}: ${overagePct.toFixed(1)}% over rehab budget`,
      });
    }
    if (
      p.targetCompletionDate &&
      new Date() > new Date(p.targetCompletionDate) &&
      p.status !== 'Sold'
    ) {
      alerts.push({
        severity: 'Red',
        category: 'Schedule',
        message: `${p.address}: past target completion (${p.targetCompletionDate})`,
      });
    }
    if (p.daysOwned >= targets.maxDaysOwnedBeforeAlert && p.status !== 'Sold') {
      alerts.push({
        severity: 'Yellow',
        category: 'Inventory',
        message: `${p.address}: owned ${p.daysOwned} days`,
      });
    }
  });

  if (resimpliData.weekly.newLeads < targets.weeklyLeadTarget) {
    alerts.push({
      severity: 'Yellow',
      category: 'Acquisitions',
      message: `Weekly leads ${resimpliData.weekly.newLeads} < target ${targets.weeklyLeadTarget}`,
    });
  }
  if (resimpliData.weekly.offersMade < targets.weeklyOfferTarget) {
    alerts.push({
      severity: 'Yellow',
      category: 'Acquisitions',
      message: `Weekly offers ${resimpliData.weekly.offersMade} < target ${targets.weeklyOfferTarget}`,
    });
  }
  if (qbo.cashOnHand < targets.minimumCashReserveWarning) {
    alerts.push({
      severity: 'Red',
      category: 'Cash',
      message: `Cash on hand $${qbo.cashOnHand.toLocaleString()} below warning $${targets.minimumCashReserveWarning.toLocaleString()}`,
    });
  }

  Object.entries(sourceErrors).forEach(([source, err]) => {
    if (err) {
      alerts.push({
        severity: 'Yellow',
        category: 'Data',
        message: `Missing data from ${source}: ${err}`,
      });
    }
  });

  const order = { Red: 0, Yellow: 1, Green: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  return alerts;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/config', (_req, res) => {
  res.json({
    targets: loadTargets(),
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    dataMode: (process.env.DATA_MODE || 'mock').toLowerCase(),
  });
});

app.get('/api/dashboard', async (_req, res) => {
  const targets = loadTargets();
  const sourceErrors = {};

  // Pull all three sources in parallel; isolate failures.
  const [qboResult, ffResult, resResult] = await Promise.all([
    quickbooks.getFinancialSnapshot().catch((e) => {
      sourceErrors.quickbooks = e.message;
      return { source: 'mock', data: null };
    }),
    flipperforce.getProjects().catch((e) => {
      sourceErrors.flipperforce = e.message;
      return { source: 'mock', data: { projects: [] } };
    }),
    resimpli.getAcquisitionsSnapshot().catch((e) => {
      sourceErrors.resimpli = e.message;
      return { source: 'mock', data: null };
    }),
  ]);

  if (qboResult.error) sourceErrors.quickbooks = qboResult.error;
  if (ffResult.error) sourceErrors.flipperforce = ffResult.error;
  if (resResult.error) sourceErrors.resimpli = resResult.error;

  const qbo = qboResult.data;
  const ff = ffResult.data;
  const resData = resResult.data;

  const normalized = normalization.normalize({ qbo, flipperforce: ff });
  const properties = riskScoring.score(normalized, targets);

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      quickbooks: qboResult.source,
      flipperforce: ffResult.source,
      resimpli: resResult.source,
    },
    sourceErrors,
    executiveSummary: buildExecutiveSummary({
      qbo,
      properties,
      resimpliData: resData,
      targets,
    }),
    acquisitions: buildAcquisitions(resData),
    projects: properties.map((p) => ({
      propertyId: p.propertyId,
      address: p.address,
      phase: p.phase,
      daysOwned: p.daysOwned,
      daysInRehab: p.daysInRehab,
      targetCompletionDate: p.targetCompletionDate,
      estimatedRehabBudget: p.estimatedRehabBudget,
      actualRehabSpend: p.actualRehabSpend,
      percentComplete: p.percentComplete,
      lastProjectUpdate: p.lastProjectUpdate,
      emptyDays: p.emptyDays,
      projectManager: p.projectManager,
      riskStatus: p.riskStatus,
      riskReasons: p.riskReasons,
      nextAction: p.nextAction,
    })),
    inventoryAging: buildInventoryAging(properties),
    cashAndCarrying: buildCashAndCarrying({ qbo, properties, targets }),
    profitForecast: buildProfitForecast(properties),
    alerts: buildAlerts({
      qbo,
      properties,
      resimpliData: resData,
      targets,
      sourceErrors,
    }),
    unifiedProperties: properties,
  };

  res.json(payload);
});

// ---------------------------------------------------------------------------
// QuickBooks OAuth handshake (one-time setup)
// ---------------------------------------------------------------------------

const QBO_STATE = `wfh-${Math.random().toString(36).slice(2)}`;

app.get('/api/qbo/status', async (_req, res) => {
  res.json(await quickbooks.connectionStatus());
});

app.get('/api/qbo/connect', (_req, res) => {
  if (!process.env.QBO_CLIENT_ID || !process.env.QBO_REDIRECT_URI) {
    return res
      .status(500)
      .send('QBO_CLIENT_ID and QBO_REDIRECT_URI must be set in .env');
  }
  res.redirect(quickbooks.buildAuthorizeUrl(QBO_STATE));
});

app.get('/api/qbo/callback', async (req, res) => {
  const { code, state, realmId } = req.query;
  if (state !== QBO_STATE) {
    return res.status(400).send('State mismatch. Restart the connect flow.');
  }
  try {
    await quickbooks.exchangeCodeForTokens(code);
    res.send(
      `<h1>QuickBooks connected.</h1>` +
        `<p>Realm ID returned: <code>${realmId || '(none)'}</code></p>` +
        `<p>You can close this tab. The dashboard will now use live QBO data on the next refresh.</p>` +
        `<p><a href="/">Back to dashboard</a></p>`,
    );
  } catch (err) {
    console.error('[qbo] callback failed:', err.message);
    res.status(500).send(`<h1>QBO connect failed</h1><pre>${err.message}</pre>`);
  }
});

// FlipperForce auth-mode probe (one-time discovery)
app.get('/api/flipperforce/probe', async (_req, res) => {
  try {
    res.json({ results: await flipperforce.probe() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REsimpli auth-mode probe (one-time discovery)
app.get('/api/resimpli/probe', async (_req, res) => {
  try {
    res.json({ results: await resimpli.probe() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// V2 placeholder endpoints
app.get('/api/v2/flip-timer', async (_req, res) => {
  res.json(await flipTimer.getFlipTimerState());
});
app.get('/api/v2/homestead-hill', async (_req, res) => {
  res.json(await homesteadHill.getHomesteadHillState());
});

// Allow editing targets at runtime so an exec can tweak thresholds.
app.put('/api/config/targets', (req, res) => {
  try {
    const current = loadTargets();
    const next = { ...current, ...req.body };
    fs.writeFileSync(TARGETS_PATH, JSON.stringify(next, null, 2));
    res.json({ ok: true, targets: next });
  } catch (err) {
    console.error('[config] failed to save targets:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`We Flip Houses dashboard listening on http://localhost:${PORT}`);
  console.log(
    `Data mode: ${(process.env.DATA_MODE || 'mock').toLowerCase()} | refresh ${REFRESH_INTERVAL_MS} ms`,
  );
});
