// Dummy HR + Team Availability data. Replaces the Keka API for the hackathon.
// When swapping to Firestore, this becomes a one-time seed script.

const STATUS = Object.freeze({
  WFH: 'WFH',
  OFFICE: 'Office',
  SICK: 'Sick',
  LEAVE: 'Leave',
});

// Default weekly pattern used when a brand-new Slack user opens the App Home.
const DEFAULT_WEEK = {
  Mon: STATUS.OFFICE,
  Tue: STATUS.OFFICE,
  Wed: STATUS.OFFICE,
  Thu: STATUS.OFFICE,
  Fri: STATUS.OFFICE,
};

// Teams are created dynamically from Slack channels via POST /api/sync-teams
const teams = {};

// Real Slack users seeded on first run.
const seedUsers = [
  {
    id: 'U0B3PJ1QP1B',       // real Slack user — Deepak (PM)
    displayName: 'Deepak',
    teamId: null,
    role: 'product_manager',
    week: { Mon: STATUS.WFH, Tue: STATUS.OFFICE, Wed: STATUS.OFFICE, Thu: STATUS.OFFICE, Fri: STATUS.WFH },
  },
  {
    id: 'U0B3WJ5RQ3W',       // real Slack user — Jithu
    displayName: 'Jithu',
    teamId: null,
    role: 'employee',
    week: { Mon: STATUS.OFFICE, Tue: STATUS.OFFICE, Wed: STATUS.WFH, Thu: STATUS.WFH, Fri: STATUS.WFH },
  },
];

// Dependency edges — seeded as a starting point, overwritten by weekly recalculation.
const seedDependencies = {
  U0B3PJ1QP1B: [
    { peerId: 'U0B3WJ5RQ3W', score: 9 },
  ],
  U0B3WJ5RQ3W: [
    { peerId: 'U0B3PJ1QP1B', score: 9 },
  ],
};

module.exports = {
  STATUS,
  DEFAULT_WEEK,
  teams,
  seedUsers,
  seedDependencies,
};
