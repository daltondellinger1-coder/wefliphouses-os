/**
 * Risk scoring service.
 *
 * Risk rules (per brief):
 *   Red    if no update in >= redAlertNoUpdateDays (default 3)
 *   Red    if over budget by >= overBudgetRedPct (default 10%)
 *   Red    if past target completion date
 *   Yellow if no update in >= yellowAlertNoUpdateDays (default 2)
 *   Yellow if over budget by >= overBudgetYellowPct (default 5%)
 *   Green  otherwise
 *
 * Severity order: Red > Yellow > Green. We always return the worst.
 */

const SEVERITY = { Green: 0, Yellow: 1, Red: 2 };

function worstOf(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function budgetOveragePct(actual, budget) {
  if (!budget || budget <= 0) return 0;
  return ((actual - budget) / budget) * 100;
}

function scoreProperty(property, targets, today = new Date().toISOString().slice(0, 10)) {
  let status = 'Green';
  const reasons = [];

  const overagePct = budgetOveragePct(
    property.actualRehabSpend || 0,
    property.estimatedRehabBudget || 0,
  );

  if (property.emptyDays != null && property.emptyDays >= targets.redAlertNoUpdateDays) {
    status = worstOf(status, 'Red');
    reasons.push(`No update in ${property.emptyDays} day(s)`);
  } else if (
    property.emptyDays != null &&
    property.emptyDays >= targets.yellowAlertNoUpdateDays
  ) {
    status = worstOf(status, 'Yellow');
    reasons.push(`No update in ${property.emptyDays} day(s)`);
  }

  if (overagePct >= targets.overBudgetRedPct) {
    status = worstOf(status, 'Red');
    reasons.push(`Over budget by ${overagePct.toFixed(1)}%`);
  } else if (overagePct >= targets.overBudgetYellowPct) {
    status = worstOf(status, 'Yellow');
    reasons.push(`Over budget by ${overagePct.toFixed(1)}%`);
  }

  if (
    property.targetCompletionDate &&
    new Date(today) > new Date(property.targetCompletionDate) &&
    property.status !== 'Sold'
  ) {
    status = worstOf(status, 'Red');
    reasons.push(`Past target completion (${property.targetCompletionDate})`);
  }

  if (
    property.daysOwned != null &&
    property.daysOwned >= targets.maxDaysOwnedBeforeAlert &&
    property.status !== 'Sold'
  ) {
    status = worstOf(status, 'Yellow');
    reasons.push(`Owned ${property.daysOwned} days`);
  }

  if (property.blockers) {
    status = worstOf(status, 'Yellow');
    reasons.push(`Blocker: ${property.blockers}`);
  }

  return { riskStatus: status, riskReasons: reasons };
}

function score(properties, targets, today = new Date().toISOString().slice(0, 10)) {
  return properties.map((p) => {
    const { riskStatus, riskReasons } = scoreProperty(p, targets, today);
    return { ...p, riskStatus, riskReasons };
  });
}

module.exports = { score, scoreProperty };
