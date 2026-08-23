import { describe, expect, it } from 'vitest';
import { analysisFrom, plyAnalysis } from '../story/storyFixtures';
import { deriveAnnotationDirectives } from './annotations';
import { archetypeSignal, gameFromMoves, moveRecord, quietGameScenario, richMateEndingScenario, storyPlanFrom, zeroMoveScenario } from './directorFixtures';

const STANDARD_STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('deriveAnnotationDirectives', () => {
  it('produces a last-move directive for every played move, independent of any beat', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    const directives = deriveAnnotationDirectives(game, analysis, understanding, story);
    const lastMoves = directives.filter((d) => d.kind === 'last-move');
    expect(lastMoves).toHaveLength(2);
    expect(lastMoves.map((d) => d.fromPly)).toEqual([1, 2]);
    expect(lastMoves[0]!.squares).toEqual(['e4']);
    expect(lastMoves[1]!.squares).toEqual(['e5']);
  });

  it('produces no directives at all for a zero-move game', () => {
    const { game, analysis, understanding, story } = zeroMoveScenario();
    expect(deriveAnnotationDirectives(game, analysis, understanding, story)).toEqual([]);
  });

  it('produces a threat-refutation-arrow only for the setup beat, from the refuting move to the threat target square', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const setupBeat = story.beats.find((b) => b.role === 'setup');
    expect(setupBeat).toBeDefined();

    const directives = deriveAnnotationDirectives(game, analysis, understanding, story);
    const arrows = directives.filter((d) => d.kind === 'threat-refutation-arrow');
    expect(arrows).toHaveLength(1);
    expect(arrows[0]!.fromPly).toBe(2); // the refuting move's own ply
    expect(arrows[0]!.squares).toEqual(['f6', 'e1']); // refuting move's `to`, then the threat's targetSquare
    expect(arrows[0]!.evidenceRef).toEqual({ kind: 'beat', id: setupBeat!.id });
  });

  it('produces a central-conflict-highlight spanning climax through resolution', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const climaxBeat = story.beats.find((b) => b.role === 'climax');
    const directives = deriveAnnotationDirectives(game, analysis, understanding, story);
    const highlight = directives.find((d) => d.kind === 'central-conflict-highlight');
    expect(highlight).toBeDefined();
    expect(highlight!.fromPly).toBe(4);
    expect(highlight!.toPly).toBe(4); // climax and resolution share ply 4 in this fixture
    expect(highlight!.evidenceRef).toEqual({ kind: 'beat', id: climaxBeat!.id });
  });

  it('fires an archetype-track directive even when the signal overlaps no beat (beatIds empty)', () => {
    const moves = [
      moveRecord(1, 'w', 'p', 'a2', 'a4', 'a4'),
      moveRecord(2, 'b', 'p', 'h7', 'h5', 'h5'),
      moveRecord(3, 'w', 'p', 'a4', 'a5', 'a5')
    ];
    const game = gameFromMoves(moves);
    const analysis = analysisFrom([plyAnalysis(1), plyAnalysis(2), plyAnalysis(3)]);
    const story = storyPlanFrom({
      beats: [],
      archetypeSignals: [archetypeSignal('pawn-journey', [1, 3], [])]
    });

    const directives = deriveAnnotationDirectives(game, analysis, {} as never, story);
    const tracks = directives.filter((d) => d.kind === 'archetype-track');
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.fromPly).toBe(1);
    expect(tracks[0]!.toPly).toBe(3);
    expect([...tracks[0]!.squares].sort()).toEqual(['a2', 'a4', 'a5'].sort());
    expect(tracks[0]!.evidenceRef).toEqual({ kind: 'archetypeSignal', archetype: 'pawn-journey' });
  });

  it('produces a terminal-result-highlight on the losing king square when the final ply is checkmate', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const directives = deriveAnnotationDirectives(game, analysis, understanding, story);
    const terminal = directives.filter((d) => d.kind === 'terminal-result-highlight');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.fromPly).toBe(4);
    expect(terminal[0]!.squares).toEqual(['e1']);
    expect(terminal[0]!.evidenceRef).toEqual({ kind: 'terminal' });
  });

  it('produces a terminal-result-highlight on the stalemated side\'s king for a drawn game', () => {
    const moves = [moveRecord(1, 'w', 'q', 'h5', 'e6', 'Qe6')];
    const game = gameFromMoves(moves);
    const analysis = analysisFrom([
      plyAnalysis(1, {
        sideToMove: 'w',
        fenAfter: STANDARD_STARTING_FEN,
        evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' }
      })
    ]);
    const story = storyPlanFrom({});

    const directives = deriveAnnotationDirectives(game, analysis, {} as never, story);
    const terminal = directives.filter((d) => d.kind === 'terminal-result-highlight');
    expect(terminal).toHaveLength(1);
    // sideToMove on the terminal ply is White -> White's own king is stalemated.
    expect(terminal[0]!.squares).toEqual(['e1']);
  });

  it('produces no terminal-result-highlight when the game is not over', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    const directives = deriveAnnotationDirectives(game, analysis, understanding, story);
    expect(directives.filter((d) => d.kind === 'terminal-result-highlight')).toEqual([]);
  });

  it('is deterministically ordered: two calls on the same inputs produce identical order', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const first = deriveAnnotationDirectives(game, analysis, understanding, story);
    const second = deriveAnnotationDirectives(game, analysis, understanding, story);
    expect(first).toEqual(second);
    // ascending fromPly, ties broken by a fixed kind order.
    for (let i = 1; i < first.length; i++) {
      expect(first[i]!.fromPly).toBeGreaterThanOrEqual(first[i - 1]!.fromPly);
    }
  });
});
