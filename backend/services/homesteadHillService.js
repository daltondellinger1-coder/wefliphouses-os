/**
 * V2 PLACEHOLDER — Homestead Hill Tracker integration.
 *
 * Purpose (V2):
 *   - Track furnished rental revenue, occupancy, unit status, maintenance,
 *     monthly NOI, and DSCR for the Homestead Hill portfolio.
 *   - Surface via /api/v2/homestead-hill.
 *
 * V1 behavior:
 *   - Returns { enabled: false }.
 */

async function getHomesteadHillState() {
  return {
    enabled: false,
    message:
      'Homestead Hill Tracker scheduled for V2. Will surface STR revenue, occupancy, NOI, and DSCR.',
    sampleSchema: {
      unitId: 'UNIT-XX',
      status: 'available|booked|maintenance',
      occupancyPct: 0,
      monthlyRevenue: 0,
      monthlyOpex: 0,
      noi: 0,
      dscr: 0,
    },
  };
}

module.exports = { getHomesteadHillState };
