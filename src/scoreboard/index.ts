/**
 * Frozen public API for Live Scoreboard.
 *
 * Browser worker/UI (S102), agent CLI/API and tests import only from this
 * module. Evaluator and session exports are added here as they land; parsing,
 * catalog and level contracts stay stable.
 */
export * from './contracts';
export * from './catalog';
export * from './level';
export * from './graph';
export {
  evaluateScoreboard,
  createScoreboardSession,
  ScoreboardSimulation,
  SCOREBOARD_SQL_DISK_LANES,
} from './simulate';
