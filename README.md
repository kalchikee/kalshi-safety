# kalshi-safety

Shared safety rails for every Kalshi prediction engine. Every repo that
can place a real bet MUST go through this module. No bypasses.

## Guarantees

- **Hard caps that no environment variable can raise**: `HARD_MAX_BET_DOLLARS`, `HARD_MAX_DAILY_EXPOSURE_DOLLARS`, `HARD_MAX_OPEN_POSITIONS`, `HARD_MAX_DAILY_LOSS_DOLLARS`, `HARD_MIN_EDGE`, `PAPER_TRADE_DAYS_REQUIRED`.
- **Fail-closed**: any unexpected error in `checkBet()` returns `blocked`.
- **Paper-trade gate**: a sport cannot graduate to live mode until it has ≥ 30 days of paper history AND ≥ 10 paper bets on record AND explicit user activation via `activateLive(sport)`.
- **Kill switch**: env `KALSHI_KILL_SWITCH=1` OR a `safety-state/KILL` file blocks every bet in every sport instantly.
- **Position reconciliation**: compare DB-expected positions to Kalshi-reported positions; alert on any divergence above tolerance.
- **Audit trail**: every `SafetyDecision` records exactly which rules passed or failed.

## Hard-limit constants (edit code to change, not env)

| Constant | Value | Meaning |
|----------|-------|---------|
| `HARD_MAX_BET_DOLLARS` | **$10** | Absolute max per single bet |
| `HARD_MAX_DAILY_EXPOSURE_DOLLARS` | **$75** | Max new-bet dollars per day |
| `HARD_MAX_OPEN_POSITIONS` | 10 | Max concurrent open positions |
| `HARD_MAX_DAILY_LOSS_DOLLARS` | $50 | Halt new bets after this much daily realized loss |
| `HARD_MIN_EDGE` | 0.05 | 5% required edge over market |
| `HARD_STOP_LOSS_PCT` | **0.20** | Auto-exit any position at 20% loss |
| `PAPER_TRADE_DAYS_REQUIRED` | 30 | Days of paper before live allowed |

Soft limits (env-configurable, clamped by hard limits above):
| Env var | Default | Meaning |
|---------|---------|---------|
| `KALSHI_MAX_BET_DOLLARS` | 10 | Per-bet cap |
| `KALSHI_MAX_DAILY_EXPOSURE_DOLLARS` | 50 | Daily exposure cap |
| `KALSHI_MAX_OPEN_POSITIONS` | 5 | Concurrent positions cap |

## Usage in a sport repo

```ts
import { checkBet, recordPaperBet } from 'kalshi-safety';

const decision = await checkBet({
  sport: 'MLB',
  ticker: 'KXMLBGAME-...',
  side: 'yes',
  priceCents: 62,
  contracts: 3,
  modelProb: 0.72,
}, {
  todayDollarsPlaced: 0,
  openPositions: [], // from your DB
  todayRealizedLoss: 0,
  requestLive: false, // default paper until explicit activation
});

if (!decision.allowed) {
  console.log('Bet blocked:', decision.reason);
  return;
}

if (decision.mode === 'paper') {
  recordPaperBet('MLB');
  // save to paper-trade DB, do NOT call Kalshi API
} else if (decision.mode === 'live') {
  // size the order with decision.cappedContracts (may be less than requested)
  await placeKalshiOrder(ticker, side, priceCents, decision.cappedContracts);
}
```

## Kill switch

Two ways to halt all betting across all sports:

1. **Per-run**: set `KALSHI_KILL_SWITCH=1` in the environment
2. **Persistent**: create `safety-state/KILL` with a one-line reason

Both are checked on every `checkBet()` call. Remove env var / delete the file to resume.

## Graduating a sport to live mode

1. Run in paper mode for ≥ 30 days
2. Accumulate ≥ 10 paper bets (`recordPaperBet(sport)` called each time)
3. Run `activateLive('<SPORT>')` once from a trusted context
4. Call `checkBet()` with `requestLive: true` — will return `mode: 'live'` if all gates pass

## Alerts

Set `KALSHI_SAFETY_DISCORD_URL` (falls back to `DISCORD_WEBHOOK_URL`) to receive alerts for:
- Kill switch activations
- Cap violations
- Reconciliation mismatches
- Internal errors in `checkBet()`

## Tests

```bash
npm ci
npm test
```

Tests cover every cap, every fail-closed path, and corrupted-state recovery.
CI runs `tsc --noEmit` + `vitest` on every push.
