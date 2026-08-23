import { describe, expect, it } from 'vitest';
import { deriveCameraDirectives } from './camera';
import { quietGameScenario, richMateEndingScenario, zeroMoveScenario } from './directorFixtures';

describe('deriveCameraDirectives', () => {
  it('returns no directives when there is no climax beat', () => {
    const { game, understanding, story } = quietGameScenario();
    expect(story.beats.find((b) => b.role === 'climax')).toBeUndefined();
    expect(deriveCameraDirectives(game, understanding, story)).toEqual([]);
  });

  it('returns no directives for a zero-move game', () => {
    const { game, understanding, story } = zeroMoveScenario();
    expect(deriveCameraDirectives(game, understanding, story)).toEqual([]);
  });

  it('anchors a square-pair directive on the climax beat, from/to the climax move', () => {
    const { game, understanding, story } = richMateEndingScenario();
    const climaxBeat = story.beats.find((b) => b.role === 'climax');
    expect(climaxBeat).toBeDefined();

    const directives = deriveCameraDirectives(game, understanding, story);
    expect(directives).toHaveLength(1);
    const directive = directives[0]!;
    expect(directive.atPly).toBe(4);
    expect(directive.focus).toBe('square-pair');
    expect(directive.evidenceRef).toEqual({ kind: 'beat', id: climaxBeat!.id });
    // The climax move (ply 4) is d8->d4.
    expect(directive.squares).toContain('d8');
    expect(directive.squares).toContain('d4');
  });

  it('includes the mated king square when the climax turning point is a forced-mate-delivery', () => {
    const { game, understanding, story } = richMateEndingScenario();
    const directives = deriveCameraDirectives(game, understanding, story);
    expect(directives).toHaveLength(1);
    // Black delivers mate at ply 4 in the fixture -> the mated king is White's,
    // and the fixture's synthetic post-ply-4 FEN is the standard starting
    // position, whose white king sits on e1.
    expect(directives[0]!.squares).toContain('e1');
  });
});
