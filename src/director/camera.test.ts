import { describe, expect, it } from 'vitest';
import { deriveCameraDirectives, zoomForSquares } from './camera';
import { DEFAULT_DIRECTOR_SETTINGS } from './types';
import { quietGameScenario, richMateEndingScenario, zeroMoveScenario } from './directorFixtures';

const SETTINGS = DEFAULT_DIRECTOR_SETTINGS;

describe('deriveCameraDirectives', () => {
  it('returns no directives when there is no climax beat', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    expect(story.beats.find((b) => b.role === 'climax')).toBeUndefined();
    expect(deriveCameraDirectives(game, analysis, understanding, story, SETTINGS)).toEqual([]);
  });

  it('returns no directives for a zero-move game', () => {
    const { game, analysis, understanding, story } = zeroMoveScenario();
    expect(deriveCameraDirectives(game, analysis, understanding, story, SETTINGS)).toEqual([]);
  });

  it('produces at least one directive covering the climax ply, anchored on a StoryBeat', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const climaxBeat = story.beats.find((b) => b.role === 'climax');
    expect(climaxBeat).toBeDefined();

    const directives = deriveCameraDirectives(game, analysis, understanding, story, SETTINGS);
    expect(directives.length).toBeGreaterThan(0);

    const critical = directives.find((d) => d.atPly <= 4 && d.untilPly >= 4);
    expect(critical).toBeDefined();
    // The climax move (ply 4) is d8->d4.
    expect(critical!.squares).toContain('d8');
    expect(critical!.squares).toContain('d4');
    // The fixture's synthetic mated-king square (e1, from its stand-in FEN)
    // sits far from the climax move's own squares, spanning nearly the
    // whole board height — zoomForSquares correctly widens toward
    // full-board here rather than cropping either square out of frame; see
    // the dedicated zoomForSquares tests below for the tighter-region case.
    expect(critical!.zoom).toBeGreaterThanOrEqual(1);
    expect(critical!.zoom).toBeLessThanOrEqual(SETTINGS.maxZoom);
  });

  it('includes the mated king square when the climax turning point is a forced-mate-delivery', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const directives = deriveCameraDirectives(game, analysis, understanding, story, SETTINGS);
    // Black delivers mate at ply 4 in the fixture -> the mated king is White's,
    // and the fixture's synthetic post-ply-4 FEN is the standard starting
    // position, whose white king sits on e1.
    const containingE1 = directives.find((d) => d.squares.includes('e1'));
    expect(containingE1).toBeDefined();
  });

  it('directives are ascending, non-overlapping in ply coverage, and every square is unique per directive', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const directives = deriveCameraDirectives(game, analysis, understanding, story, SETTINGS);
    for (let i = 1; i < directives.length; i++) {
      expect(directives[i]!.atPly).toBeGreaterThan(directives[i - 1]!.untilPly);
    }
    for (const d of directives) {
      expect(new Set(d.squares).size).toBe(d.squares.length);
    }
  });

  it('produces a wider (or equal) camera for a game whose only evidence is an establishing shot spanning many squares than for a single tight square-pair', () => {
    const wide = zoomForSquares(['a1', 'h8'], SETTINGS); // opposite corners — spans the whole board
    const tight = zoomForSquares(['e4', 'e5'], SETTINGS); // adjacent squares
    expect(wide).toBeLessThanOrEqual(tight);
    expect(wide).toBe(1); // widens to full board rather than cropping
  });
});

describe('zoomForSquares', () => {
  it('never crops: a larger bounding box never produces a tighter zoom than a smaller one', () => {
    const small = zoomForSquares(['e4'], SETTINGS);
    const medium = zoomForSquares(['e4', 'e5'], SETTINGS);
    const large = zoomForSquares(['a1', 'a8', 'h1', 'h8'], SETTINGS);
    expect(small).toBeGreaterThanOrEqual(medium);
    expect(medium).toBeGreaterThanOrEqual(large);
  });

  it('never exceeds settings.maxZoom nor drops below 1 (full board)', () => {
    expect(zoomForSquares(['e4'], SETTINGS)).toBeLessThanOrEqual(SETTINGS.maxZoom);
    expect(zoomForSquares([], SETTINGS)).toBe(1);
    expect(zoomForSquares(['a1', 'h8'], SETTINGS)).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic', () => {
    expect(zoomForSquares(['e4', 'd5', 'c6'], SETTINGS)).toBe(zoomForSquares(['e4', 'd5', 'c6'], SETTINGS));
  });
});
