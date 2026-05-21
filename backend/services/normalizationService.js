/**
 * Normalization service.
 *
 * Merges QuickBooks (financials by class), FlipperForce (project execution),
 * and REsimpli (acquisition pipeline) into ONE unified property/deal model.
 *
 * Join keys:
 *   - QBO Class name === FlipperForce projectId  (operator must enforce this)
 *   - REsimpli leads convert into FlipperForce projects on close; we surface
 *     them in the acquisitions pipeline rather than joining them in by id.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  const a = new Date(later).getTime();
  const b = new Date(earlier).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function indexQboByClass(qbo) {
  const map = new Map();
  (qbo.classExpenses || []).forEach((c) => map.set(c.class, c));
  return map;
}

/**
 * The unified property/deal model as specified in the brief.
 * Any field that cannot be derived yet is left null so the UI can show "—".
 */
function buildPropertyRecord({ project, qboClass, today, dailyCarryingCostFallback }) {
  const daysOwned = daysBetween(today, project.purchaseDate);
  const daysInRehab = daysBetween(today, project.rehabStartDate);
  const emptyDays = daysBetween(today, project.lastProjectUpdate);

  const actualRehabSpend = qboClass ? qboClass.rehabSpend : project.actualRehabSpend;
  const actualHoldingCosts = qboClass ? qboClass.holdingCosts : null;
  const interestPayments = qboClass ? qboClass.interestPayments : null;

  // Heuristic daily carrying cost when we don't have a richer model:
  // taxes + insurance + utilities + interest accrual amortized over days owned.
  const totalHolding =
    (actualHoldingCosts || 0) + (interestPayments || 0);
  const derivedDaily =
    daysOwned && totalHolding ? Number((totalHolding / daysOwned).toFixed(2)) : null;
  const dailyCarryingCost = derivedDaily || dailyCarryingCostFallback;

  const sellingCostsPct = 0.08; // commissions + closing — rough V1 assumption
  const projectedGrossProfit =
    project.arv != null && project.purchasePrice != null
      ? project.arv - project.purchasePrice - (project.budgetedRehab || 0)
      : null;
  const projectedNetProfit =
    projectedGrossProfit != null
      ? Math.round(
          projectedGrossProfit -
            project.arv * sellingCostsPct -
            (actualHoldingCosts || 0) -
            (interestPayments || 0),
        )
      : null;

  return {
    propertyId: project.projectId,
    address: project.address,
    city: project.city,
    acquisitionSource: null, // populated from REsimpli when join is wired
    leadSource: null,
    purchaseDate: project.purchaseDate,
    contractDate: null,
    closeDate: project.purchaseDate, // V1: treat purchase as close
    rehabStartDate: project.rehabStartDate,
    targetCompletionDate: project.targetCompletionDate,
    listDate: project.listDate,
    saleDate: project.saleDate,
    status: project.status,
    phase: project.phase,
    arv: project.arv,
    purchasePrice: project.purchasePrice,
    estimatedRehabBudget: project.budgetedRehab,
    actualRehabSpend,
    estimatedHoldingCosts: null,
    actualHoldingCosts,
    dailyCarryingCost,
    projectedGrossProfit,
    projectedNetProfit,
    actualNetProfit: null,
    projectManager: project.projectManager,
    acquisitionsManager: null,
    lastProjectUpdate: project.lastProjectUpdate,
    emptyDays,
    nextAction: project.nextAction,
    blockers: project.blockers,
    daysOwned,
    daysInRehab,
    percentComplete: project.percentComplete,
    interestPayments,
    riskStatus: null, // filled in by riskScoringService
    riskReasons: [],
  };
}

function normalize({ qbo, flipperforce, today = new Date().toISOString().slice(0, 10) }) {
  const qboIndex = indexQboByClass(qbo);
  const properties = (flipperforce.projects || []).map((project) =>
    buildPropertyRecord({
      project,
      qboClass: qboIndex.get(project.projectId),
      today,
      dailyCarryingCostFallback: 95, // sane default: ~$2,850/mo carrying cost
    }),
  );
  return properties;
}

module.exports = { normalize, daysBetween };
