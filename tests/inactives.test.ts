import { describe, it, expect } from 'vitest';
import { mlbTeamsFromTicker, mlbIsoDateFromTicker } from '../src/service/inactives.js';

describe('mlbTeamsFromTicker', () => {
  it('parses standard 3-letter / 3-letter tickers', () => {
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR272210MIALAD-MIA'))
      .toEqual({ away: 'MIA', home: 'LAD' });
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR251915PHIATL-ATL'))
      .toEqual({ away: 'PHI', home: 'ATL' });
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR272005NYYTEX-NYY'))
      .toEqual({ away: 'NYY', home: 'TEX' });
  });

  it('regression: 2-letter codes (KC, SD, SF, TB) parse correctly', () => {
    // These would mis-parse with a greedy regex `([A-Z]{2,3})([A-Z]{2,3})`.
    // Bug surfaced 2026-04-30 audit when realizing a KC-vs-CWS ticker would
    // greedy-split as "KCC@WS" → MLB Stats lookup 404 → false alert spam.
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR281710KCCWS-KC'))
      .toEqual({ away: 'KC', home: 'CWS' });
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR281710SDSEA-SD'))
      .toEqual({ away: 'SD', home: 'SEA' });
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR281710SFNYM-SF'))
      .toEqual({ away: 'SF', home: 'NYM' });
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR281710TBBAL-TB'))
      .toEqual({ away: 'TB', home: 'BAL' });
  });

  it('regression: 2-letter against 2-letter (rare but possible)', () => {
    // SF @ KC: should split SF + KC, not SFK + C (bad) or some other mess.
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR281710SFKC-KC'))
      .toEqual({ away: 'SF', home: 'KC' });
  });

  it('returns null on garbage input', () => {
    expect(mlbTeamsFromTicker('KXMLBGAME-bogus')).toBeNull();
    expect(mlbTeamsFromTicker('not-an-mlb-ticker')).toBeNull();
    expect(mlbTeamsFromTicker('')).toBeNull();
  });

  it('returns null when one half is not a real Kalshi code', () => {
    // "ZZZBOS" — ZZZ is not a real team
    expect(mlbTeamsFromTicker('KXMLBGAME-26APR272210ZZZBOS-BOS')).toBeNull();
  });
});

describe('mlbIsoDateFromTicker', () => {
  it('extracts ISO date from a Kalshi MLB ticker', () => {
    expect(mlbIsoDateFromTicker('KXMLBGAME-26APR272210MIALAD-MIA')).toBe('2026-04-27');
    expect(mlbIsoDateFromTicker('KXMLBGAME-26JAN012005NYYTEX-NYY')).toBe('2026-01-01');
  });

  it('returns null on bad month abbreviation', () => {
    expect(mlbIsoDateFromTicker('KXMLBGAME-26ZZZ012005NYYTEX-NYY')).toBeNull();
  });

  it('returns null on non-MLB ticker', () => {
    expect(mlbIsoDateFromTicker('KXNBAGAME-26APR27OKCPHX-OKC')).toBeNull();
  });
});
