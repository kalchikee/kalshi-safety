import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isKillSwitchActive } from '../src/killSwitch.js';

const TMP_KILL = resolve(process.cwd(), 'safety-state', 'test-KILL');

describe('killSwitch', () => {
  afterEach(() => {
    if (existsSync(TMP_KILL)) unlinkSync(TMP_KILL);
    delete process.env.KALSHI_KILL_SWITCH;
  });

  it('env-based activation', () => {
    process.env.KALSHI_KILL_SWITCH = '1';
    const r = isKillSwitchActive(TMP_KILL);
    expect(r.active).toBe(true);
    expect(r.triggeredBy).toBe('environment');
  });

  it('env value "0" means not active', () => {
    process.env.KALSHI_KILL_SWITCH = '0';
    expect(isKillSwitchActive(TMP_KILL).active).toBe(false);
  });

  it('env value "false" means not active', () => {
    process.env.KALSHI_KILL_SWITCH = 'false';
    expect(isKillSwitchActive(TMP_KILL).active).toBe(false);
  });

  it('file-based activation', () => {
    mkdirSync(resolve(process.cwd(), 'safety-state'), { recursive: true });
    writeFileSync(TMP_KILL, 'emergency stop: testing');
    const r = isKillSwitchActive(TMP_KILL);
    expect(r.active).toBe(true);
    expect(r.triggeredBy).toBe('file');
    expect(r.reason).toContain('emergency');
  });

  it('default: not active', () => {
    const r = isKillSwitchActive(TMP_KILL);
    expect(r.active).toBe(false);
  });
});
