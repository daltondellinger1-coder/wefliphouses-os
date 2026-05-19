/**
 * V2 PLACEHOLDER — Flip Timer App integration.
 *
 * Purpose (V2):
 *   - Track days owned, days in phase, daily holding cost, and urgency score
 *     per property in real time.
 *   - Push timer state to the dashboard via /api/v2/flip-timer.
 *
 * V1 behavior:
 *   - Returns { enabled: false } so the UI shows a disabled tab.
 *   - No external calls.
 */

async function getFlipTimerState() {
  return {
    enabled: false,
    message:
      'Flip Timer App integration scheduled for V2. Will surface days-in-phase and urgency scoring.',
    sampleSchema: {
      propertyId: 'PROP-XXX',
      daysOwned: 0,
      daysInPhase: 0,
      currentPhase: '',
      dailyHoldingCost: 0,
      urgencyScore: 0,
    },
  };
}

module.exports = { getFlipTimerState };
