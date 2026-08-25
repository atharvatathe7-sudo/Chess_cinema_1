import { describe, expect, it } from 'vitest';
import type { CinematicMoment } from '../state/moments';
import { TERMINAL_HOLD_MS, terminalHoldFrameCount, terminalHoldFreezeTimeMs } from './runExport';

/**
 * Phase 12A — pure-logic coverage for the terminal-caption hold helpers.
 * Real exported-WebM-frame coverage (the actual visual/timing effect) is
 * tests/e2e/terminalHold.spec.ts's job, the same drawHook.ts/drawHook.test.ts
 * split this project already uses.
 */

function fixtureMoment(kind: CinematicMoment['kind'], atMs: number, untilMs: number): CinematicMoment {
  return {
    id: `${kind}-${atMs}`,
    kind,
    label: 'Label',
    reason: 'Reason',
    narratives: [{ label: 'Label', reason: 'Reason' }],
    fromPly: 1,
    toPly: 1,
    atMs,
    untilMs,
    targetTimeMs: untilMs - 1
  };
}

describe('terminalHoldFrameCount', () => {
  it('is 0 when there are no Moments at all (e.g. Quiet)', () => {
    expect(terminalHoldFrameCount([], 24)).toBe(0);
  });

  it('is 0 when the last Moment is not terminal-result-highlight (e.g. Promotion race)', () => {
    const moments = [fixtureMoment('archetype-track', 0, 5800)];
    expect(terminalHoldFrameCount(moments, 24)).toBe(0);
  });

  it('is 0 when a terminal Moment exists but is not the chronologically last one', () => {
    const moments = [fixtureMoment('terminal-result-highlight', 100, 400), fixtureMoment('central-conflict-highlight', 400, 900)];
    expect(terminalHoldFrameCount(moments, 24)).toBe(0);
  });

  it('is TERMINAL_HOLD_MS worth of frames at the given fps when the last Moment is terminal-result-highlight', () => {
    const moments = [fixtureMoment('central-conflict-highlight', 1200, 3300), fixtureMoment('terminal-result-highlight', 3300, 3600)];
    expect(terminalHoldFrameCount(moments, 24)).toBe(Math.round((TERMINAL_HOLD_MS / 1000) * 24));
  });

  it('scales with fps deterministically', () => {
    const moments = [fixtureMoment('terminal-result-highlight', 9500, 9800)];
    expect(terminalHoldFrameCount(moments, 30)).toBe(Math.round((TERMINAL_HOLD_MS / 1000) * 30));
    expect(terminalHoldFrameCount(moments, 12)).toBe(Math.round((TERMINAL_HOLD_MS / 1000) * 12));
  });

  it('is deterministic: identical input always produces identical output', () => {
    const moments = [fixtureMoment('terminal-result-highlight', 16750, 17050)];
    expect(terminalHoldFrameCount(moments, 24)).toBe(terminalHoldFrameCount(moments, 24));
  });
});

describe('terminalHoldFreezeTimeMs', () => {
  it('is 1ms before the scene duration, so it stays strictly inside a terminal Moment\'s exclusive untilMs === sceneDurationMs', () => {
    expect(terminalHoldFreezeTimeMs(3600)).toBe(3599);
    expect(terminalHoldFreezeTimeMs(17050)).toBe(17049);
    expect(terminalHoldFreezeTimeMs(9800)).toBe(9799);
  });

  it('never goes negative for a degenerate zero-duration scene', () => {
    expect(terminalHoldFreezeTimeMs(0)).toBe(0);
  });
});
