import { describe, expect, it } from 'vitest';
import type { CinematicMoment } from '../state/moments';
import { activeMomentAt, buildCaptionContent, clampToMaxLines, MAX_REASON_LINES, wrapText, type MeasureTextWidth } from './drawCaptions';

/**
 * Phase 6 — pure-logic coverage only, per vitest.config.ts's own documented
 * split (no canvas/DOM here); the actual Canvas 2D/OffscreenCanvas drawing
 * — real pixels, real fonts — is covered by tests/e2e/videoExport.spec.ts
 * (Playwright/Chromium), the same split director/annotations.ts and
 * render/drawAnnotations.ts already use.
 */

/** Hand-built, same fixture convention as state/moments.test.ts's own comment: this file is about drawCaptions.ts's own logic given already-correct CinematicMoment data, not about re-deriving it. */
function fixtureMoment(overrides: Partial<CinematicMoment> = {}): CinematicMoment {
  const label = overrides.label ?? 'Climax';
  const reason = overrides.reason ?? 'The decisive moment of the game.';
  return {
    id: overrides.id ?? 'central-conflict-highlight-1-1',
    kind: overrides.kind ?? 'central-conflict-highlight',
    label,
    reason,
    narratives: overrides.narratives ?? [{ label, reason }],
    fromPly: overrides.fromPly ?? 1,
    toPly: overrides.toPly ?? 1,
    atMs: overrides.atMs ?? 0,
    untilMs: overrides.untilMs ?? 1000,
    targetTimeMs: overrides.targetTimeMs ?? 999
  };
}

/** A simple, deterministic synthetic width function (monospace-like) so wrap-point assertions don't depend on any real font/browser. */
const MONOSPACE_CHAR_WIDTH = 8;
const monospaceMeasure: MeasureTextWidth = (text) => text.length * MONOSPACE_CHAR_WIDTH;

describe('activeMomentAt', () => {
  it('returns null when there are zero Moments', () => {
    expect(activeMomentAt([], 500)).toBeNull();
  });

  it('returns the single Moment when logicalTimeMs falls inside its window', () => {
    const moment = fixtureMoment({ atMs: 100, untilMs: 200 });
    expect(activeMomentAt([moment], 150)).toBe(moment);
  });

  it('returns null before atMs and at/after untilMs for a single Moment', () => {
    const moment = fixtureMoment({ atMs: 100, untilMs: 200 });
    expect(activeMomentAt([moment], 99)).toBeNull();
    expect(activeMomentAt([moment], 200)).toBeNull();
    expect(activeMomentAt([moment], 300)).toBeNull();
  });

  it('is inclusive at the exact atMs boundary', () => {
    const moment = fixtureMoment({ atMs: 1000, untilMs: 2000 });
    expect(activeMomentAt([moment], 1000)).toBe(moment);
  });

  it('is exclusive at the exact untilMs boundary', () => {
    const moment = fixtureMoment({ atMs: 1000, untilMs: 2000 });
    expect(activeMomentAt([moment], 2000)).toBeNull();
    expect(activeMomentAt([moment], 1999)).toBe(moment);
  });

  it('transitions cleanly across two adjacent (back-to-back, non-overlapping) Moment intervals', () => {
    const first = fixtureMoment({ id: 'a', label: 'Threat Refutation', atMs: 0, untilMs: 1000 });
    const second = fixtureMoment({ id: 'b', label: 'Climax', atMs: 1000, untilMs: 2000 });
    const moments = [first, second];

    expect(activeMomentAt(moments, 999)).toBe(first);
    // The exact boundary belongs to the second interval only (first's untilMs is exclusive) — never both, never neither.
    expect(activeMomentAt(moments, 1000)).toBe(second);
    expect(activeMomentAt(moments, 1001)).toBe(second);
  });

  it('returns null in the gap between two non-adjacent Moments, and resumes at the next one\'s atMs', () => {
    const first = fixtureMoment({ id: 'a', atMs: 0, untilMs: 500 });
    const second = fixtureMoment({ id: 'b', atMs: 800, untilMs: 1200 });
    const moments = [first, second];

    expect(activeMomentAt(moments, 600)).toBeNull();
    expect(activeMomentAt(moments, 799)).toBeNull();
    expect(activeMomentAt(moments, 800)).toBe(second);
  });
});

describe('wrapText', () => {
  it('returns an empty array for empty input', () => {
    expect(wrapText(monospaceMeasure, '', 1000)).toEqual([]);
  });

  it('keeps short text on a single line', () => {
    expect(wrapText(monospaceMeasure, 'Climax', 1000)).toEqual(['Climax']);
  });

  it('wraps onto a new line once a word would exceed maxWidth', () => {
    // Each char is 8 units wide; "one two" is 7 chars = 56 units, fits in 60;
    // adding "three" (5 more chars = 40 units) would make 96, which doesn't fit 60.
    const lines = wrapText(monospaceMeasure, 'one two three', 60);
    expect(lines).toEqual(['one two', 'three']);
  });

  it('keeps a single word wider than maxWidth whole on its own line rather than breaking it', () => {
    const lines = wrapText(monospaceMeasure, 'supercalifragilisticexpialidocious short', 40);
    expect(lines[0]).toBe('supercalifragilisticexpialidocious');
    expect(lines).toHaveLength(2);
  });

  it('wraps a long realistic narrative string (the app\'s own longest closed-vocabulary reason phrase) into multiple lines', () => {
    // Verbatim ARCHETYPE_REASON['king-hunt'] from state/moments.ts — the
    // investigation's own empirically-longest real reason string.
    const longest = 'A forced sequence of checks drove the king across the board, ending in mate.';
    const lines = wrapText(monospaceMeasure, longest, 300);
    expect(lines.length).toBeGreaterThan(1);
    // No information lost: rejoining every line reproduces the original words exactly.
    expect(lines.join(' ')).toBe(longest);
    for (const line of lines) {
      expect(monospaceMeasure(line)).toBeLessThanOrEqual(300);
    }
  });

  it('is deterministic: identical input always produces identical output', () => {
    const text = 'The decisive moment — a fork led to a decisive advantage.';
    const first = wrapText(monospaceMeasure, text, 200);
    const second = wrapText(monospaceMeasure, text, 200);
    expect(second).toEqual(first);
  });
});

describe('clampToMaxLines', () => {
  it('is a no-op when the line count is already within the limit', () => {
    const lines = ['one', 'two'];
    expect(clampToMaxLines(monospaceMeasure, lines, 1000, 2)).toEqual(['one', 'two']);
  });

  it('collapses overflow lines into one ellipsis-suffixed final line that fits maxWidth', () => {
    const lines = ['one two', 'three four', 'five six'];
    const maxWidth = 100;
    const clamped = clampToMaxLines(monospaceMeasure, lines, maxWidth, 2);

    expect(clamped).toHaveLength(2);
    expect(clamped[0]).toBe('one two');
    expect(clamped[1]!.endsWith('…')).toBe(true);
    expect(monospaceMeasure(clamped[1]!)).toBeLessThanOrEqual(maxWidth);
  });

  it('is deterministic across repeated calls with identical input', () => {
    const lines = ['a b c d e', 'f g h i j', 'k l m n o'];
    const first = clampToMaxLines(monospaceMeasure, lines, 80, 2);
    const second = clampToMaxLines(monospaceMeasure, lines, 80, 2);
    expect(second).toEqual(first);
  });
});

describe('buildCaptionContent', () => {
  it('uses only the primary narrative (moment.label/moment.reason), never a secondary "Also true" entry', () => {
    const moment = fixtureMoment({
      label: 'Climax',
      reason: 'The decisive moment of the game.',
      narratives: [
        { label: 'Climax', reason: 'The decisive moment of the game.' },
        { label: 'King Hunt', reason: 'A forced sequence of checks drove the king across the board, ending in mate.' }
      ]
    });

    const content = buildCaptionContent(monospaceMeasure, moment, 1000);
    expect(content.label).toBe('Climax');
    expect(content.reasonLines.join(' ')).toBe('The decisive moment of the game.');
    expect(content.label).not.toBe('King Hunt');
  });

  it('never produces more than MAX_REASON_LINES reason lines, even for a very long reason at a narrow width', () => {
    const longest = fixtureMoment({
      reason: 'A forced sequence of checks drove the king across the board, ending in mate.'
    });
    const content = buildCaptionContent(monospaceMeasure, longest, 80);
    expect(content.reasonLines.length).toBeLessThanOrEqual(MAX_REASON_LINES);
  });

  it('handles a Moment whose reason already fits on one line', () => {
    const moment = fixtureMoment({ label: 'Checkmate', reason: 'The game ended in checkmate.' });
    const content = buildCaptionContent(monospaceMeasure, moment, 1000);
    expect(content.label).toBe('Checkmate');
    expect(content.reasonLines).toEqual(['The game ended in checkmate.']);
  });

  it('is deterministic across repeated calls with an identical Moment', () => {
    const moment = fixtureMoment({ reason: 'A threatened mate was refuted here.' });
    const first = buildCaptionContent(monospaceMeasure, moment, 120);
    const second = buildCaptionContent(monospaceMeasure, moment, 120);
    expect(second).toEqual(first);
  });
});
