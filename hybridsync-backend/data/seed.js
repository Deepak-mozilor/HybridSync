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

// Real Slack users first, then demo fill-ins.
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
  {
    id: 'U_RIYA',
    displayName: 'Riya',
    teamId: null,
    role: 'employee',
    week: { Mon: STATUS.WFH, Tue: STATUS.OFFICE, Wed: STATUS.WFH, Thu: STATUS.OFFICE, Fri: STATUS.OFFICE },
  },
  {
    id: 'U_KARAN',
    displayName: 'Karan',
    teamId: null,
    role: 'employee',
    week: { Mon: STATUS.OFFICE, Tue: STATUS.WFH, Wed: STATUS.OFFICE, Thu: STATUS.WFH, Fri: STATUS.WFH },
  },
];

// Dependency edges (userId -> [{ peerId, score }]). Score 1-10.
// Real users get high scores so negotiation DMs actually fire.
const seedDependencies = {
  U0B3PJ1QP1B: [       // Deepak (PM)
    { peerId: 'U0B3WJ5RQ3W', score: 9 },  // Jithu — critical collaborator
    { peerId: 'U_RIYA',      score: 7 },
    { peerId: 'U_KARAN',     score: 4 },
  ],
  U0B3WJ5RQ3W: [       // Jithu
    { peerId: 'U0B3PJ1QP1B', score: 9 },  // Deepak — critical collaborator
    { peerId: 'U_RIYA',      score: 6 },
  ],
  U_RIYA: [
    { peerId: 'U0B3PJ1QP1B', score: 7 },
    { peerId: 'U0B3WJ5RQ3W', score: 6 },
  ],
  U_KARAN: [
    { peerId: 'U0B3PJ1QP1B', score: 4 },
  ],
};

module.exports = {
  STATUS,
  DEFAULT_WEEK,
  teams,
  seedUsers,
  seedDependencies,
};
