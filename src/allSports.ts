// Canonical list of sports participating in the monthly dry-run.
// Every repo imports from this list so we have a single source of truth.
//
// A sport is in dry-run from the moment its repo first calls loadPaperState().
// This list is used by the safety repo's daily-summary cron to post one
// Discord embed per sport per day, even when a sport has 0 bets that day.

export const DRY_RUN_SPORTS = [
  'NBA',
  'NFL',
  'MLB',
  'NHL',
  'EPL',
  'MLS',
  'NCAAM',
  'NCAAF',
  'NCAAW',
  'UFC',
  'WNBA',
  'F1',
  'TENNIS',       // Grand Slams
  'MARCH_MADNESS',
  'PARLAY',
  'PREDICT',
] as const;

export type DryRunSport = typeof DRY_RUN_SPORTS[number];
