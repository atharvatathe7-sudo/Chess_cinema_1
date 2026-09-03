import { describe, expect, it } from 'vitest';
import type { Evaluation, GameAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import { buildArchetypeSignals } from './archetypes';
import { DEFAULT_STORY_SETTINGS } from './types';
import { analysisFrom, gameArc, plyAnalysis, understandingFrom, unknownOutcome } from './storyFixtures';
import type { GameRecord } from '../pgn/types';

/**
 * Phase 16 (MUST HAVE 6) — generalized stalemate-blunder detection.
 *
 * The shape: a side that was clearly winning delivers stalemate and draws a
 * game it should have won. This is the MIRROR of stalemate-swindle, which
 * credits the side that was BEHIND for escaping — so the two must never both
 * fire, and the wrong one firing would state the opposite of what happened.
 *
 * Everything below is expressed structurally: material trajectory, evaluation
 * before the final move, and the resolved GameOutcome. No game id, FEN, SAN,
 * or move number from any benchmark appears here.
 */

const EMPTY_GAME: GameRecord = { headers: {}, moves: [], positions: [] };

const STALEMATE_EVAL: Evaluation = { kind: 'terminal', result: 'draw', drawReason: 'stalemate' };

/**
 * A game ending in stalemate on ply `finalPly`, delivered by the side whose
 * parity owns that ply, with `materialDiff` (White-relative) standing just
 * before the final move and `evalBeforeCp` (White-relative) on the board.
 */
function stalemateGame(options: {
  finalPly: number;
  materialDiff: number;
  evalBeforeCp: number;
  finalEvaluation?: Evaluation;
}): { analysis: GameAnalysis; understanding: GameUnderstanding } {
  const { finalPly, materialDiff, evalBeforeCp, finalEvaluation = STALEMATE_EVAL } = options;
  const plies = [
    plyAnalysis(finalPly - 1, { evaluationAfter: { kind: 'cp', cp: evalBeforeCp } }),
    plyAnalysis(finalPly, {
      evaluationBefore: { kind: 'cp', cp: evalBeforeCp },
      evaluationAfter: finalEvaluation
    })
  ];
  const understanding = understandingFrom({
    plies: [],
    gameArc: gameArc(0, 0, [
      { ply: finalPly - 1, materialDiff },
      { ply: finalPly, materialDiff }
    ])
  });
  return { analysis: analysisFrom(plies), understanding };
}

/** The GameOutcome GATE 0 resolves for a real on-board stalemate. */
function stalemateOutcome(materialDiff: number) {
  return unknownOutcome({
    result: '1/2-1/2',
    termination: 'stalemate',
    onBoard: true,
    finalEvaluation: STALEMATE_EVAL,
    finalMaterialDiff: materialDiff,
    source: 'engine-terminal',
    confidence: 1
  });
}

function signalsFor(options: Parameters<typeof stalemateGame>[0]) {
  const { analysis, understanding } = stalemateGame(options);
  return buildArchetypeSignals(
    EMPTY_GAME,
    analysis,
    understanding,
    stalemateOutcome(options.materialDiff),
    DEFAULT_STORY_SETTINGS,
    []
  );
}

const MATERIAL_FLOOR = DEFAULT_STORY_SETTINGS.blunderMaterialAdvantageFloor;
const EVAL_FLOOR = DEFAULT_STORY_SETTINGS.blunderEvalAdvantageFloor;

/**
 * An odd ply is White's move, so an odd finalPly means WHITE delivered the
 * stalemate and a positive (White-relative) materialDiff is White's advantage.
 */
const WHITE_DELIVERS = 41;
/** An even ply is Black's move; the sign of every White-relative quantity flips. */
const BLACK_DELIVERS = 42;

describe('material threshold boundary', () => {
  it('does NOT fire one unit below the material floor', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: MATERIAL_FLOOR - 1, evalBeforeCp: 900 });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });

  it('fires EXACTLY at the material floor', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: MATERIAL_FLOOR, evalBeforeCp: 900 });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeDefined();
  });

  it('fires clearly above the material floor', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: MATERIAL_FLOOR + 2000, evalBeforeCp: 2500 });
    const blunder = signals.find((s) => s.archetype === 'stalemate-blunder');
    expect(blunder).toBeDefined();
    expect(blunder!.plies).toEqual([WHITE_DELIVERS]);
    expect(blunder!.evidence.basis).toBe('engine-eval');
  });
});

describe('evaluation corroboration is required, not optional', () => {
  it('does NOT fire on material advantage with insufficient evaluation advantage', () => {
    // A rook up in a position the engine reads as level — a locked or
    // fortress-like ending, where a stalemate throws away nothing. Calling
    // this a blunder would be a fabricated accusation.
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: MATERIAL_FLOOR + 500, evalBeforeCp: EVAL_FLOOR - 1 });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });

  it('fires exactly at the evaluation floor', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: MATERIAL_FLOOR + 500, evalBeforeCp: EVAL_FLOOR });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeDefined();
  });

  it('does NOT fire when the evaluation favours the side that was STALEMATED', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: MATERIAL_FLOOR + 500, evalBeforeCp: -900 });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });
});

describe('neutral stalemate', () => {
  it('produces neither archetype when nobody was winning', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: 0, evalBeforeCp: 0 });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
    expect(signals.find((s) => s.archetype === 'stalemate-swindle')).toBeUndefined();
  });
});

describe('losing-side stalemate swindle stays a swindle', () => {
  it('fires stalemate-swindle, and never stalemate-blunder, when the stalemating side was BEHIND', () => {
    // White delivers stalemate while a queen down: the classic swindle. The
    // blunder rule must stay silent — crediting the loser is the whole point
    // of "swindle", and accusing them of throwing away a win would be false.
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: -900, evalBeforeCp: -900 });
    expect(signals.find((s) => s.archetype === 'stalemate-swindle')).toBeDefined();
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });
});

describe('winning-side stalemate throwaway', () => {
  it('fires stalemate-blunder, and never stalemate-swindle, when the stalemating side was AHEAD', () => {
    const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff: 900, evalBeforeCp: 1200 });
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeDefined();
    expect(signals.find((s) => s.archetype === 'stalemate-swindle')).toBeUndefined();
  });

  it('detects the same shape when BLACK is the side that threw the win away', () => {
    // Every White-relative quantity flips sign; the rule must be colour-blind.
    const signals = signalsFor({ finalPly: BLACK_DELIVERS, materialDiff: -900, evalBeforeCp: -1200 });
    const blunder = signals.find((s) => s.archetype === 'stalemate-blunder');
    expect(blunder).toBeDefined();
    expect(blunder!.plies).toEqual([BLACK_DELIVERS]);
  });

  it('treats a forced mate held in the run-up as the strongest corroboration', () => {
    const { analysis, understanding } = stalemateGame({ finalPly: WHITE_DELIVERS, materialDiff: 900, evalBeforeCp: 0 });
    const withMate = analysisFrom([
      { ...analysis.plies[0]!, evaluationAfter: { kind: 'mate', mateIn: 2 } },
      analysis.plies[1]!
    ]);
    const signals = buildArchetypeSignals(EMPTY_GAME, withMate, understanding, stalemateOutcome(900), DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeDefined();
  });

  it('still fires when the evaluation has ALREADY collapsed to level by the final move', () => {
    // The defect this measurement window exists to fix, as a regression test.
    //
    // A stalemate that is one move away is scored ~0.00 by the engine BECAUSE
    // the draw is already visible — so reading the evaluation immediately
    // before the final move asks "is this side still winning after the
    // blunder?", which is nearly always no. A side that held a decisive
    // advantage right up to the move that threw it away must still be
    // recognised.
    const finalPly = WHITE_DELIVERS;
    const plies = [
      // Held a winning position through the run-up ...
      plyAnalysis(finalPly - 3, { evaluationAfter: { kind: 'cp', cp: 1000 } }),
      plyAnalysis(finalPly - 2, { evaluationAfter: { kind: 'cp', cp: 1000 } }),
      // ... then the advantage evaporates as the stalemate becomes forced.
      plyAnalysis(finalPly - 1, { evaluationAfter: { kind: 'cp', cp: 0 } }),
      plyAnalysis(finalPly, { evaluationBefore: { kind: 'cp', cp: 0 }, evaluationAfter: STALEMATE_EVAL })
    ];
    const understanding = understandingFrom({
      plies: [],
      gameArc: gameArc(0, 0, [
        { ply: finalPly - 1, materialDiff: 900 },
        { ply: finalPly, materialDiff: 900 }
      ])
    });
    const signals = buildArchetypeSignals(
      EMPTY_GAME,
      analysisFrom(plies),
      understanding,
      stalemateOutcome(900),
      DEFAULT_STORY_SETTINGS,
      []
    );
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeDefined();
  });

  it('does NOT fire when the side was never winning at any point in the window', () => {
    // The window must not become a loophole: looking back is only allowed to
    // see an advantage that was genuinely there.
    const finalPly = WHITE_DELIVERS;
    const plies = [
      plyAnalysis(finalPly - 3, { evaluationAfter: { kind: 'cp', cp: 20 } }),
      plyAnalysis(finalPly - 2, { evaluationAfter: { kind: 'cp', cp: 10 } }),
      plyAnalysis(finalPly - 1, { evaluationAfter: { kind: 'cp', cp: 0 } }),
      plyAnalysis(finalPly, { evaluationBefore: { kind: 'cp', cp: 0 }, evaluationAfter: STALEMATE_EVAL })
    ];
    const understanding = understandingFrom({
      plies: [],
      gameArc: gameArc(0, 0, [
        { ply: finalPly - 1, materialDiff: 900 },
        { ply: finalPly, materialDiff: 900 }
      ])
    });
    const signals = buildArchetypeSignals(
      EMPTY_GAME,
      analysisFrom(plies),
      understanding,
      stalemateOutcome(900),
      DEFAULT_STORY_SETTINGS,
      []
    );
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });
});

describe('mutual exclusivity is structural, not incidental', () => {
  it('never produces both archetypes, across the full material range', () => {
    for (let materialDiff = -2000; materialDiff <= 2000; materialDiff += 100) {
      const signals = signalsFor({ finalPly: WHITE_DELIVERS, materialDiff, evalBeforeCp: materialDiff });
      const both =
        signals.some((s) => s.archetype === 'stalemate-blunder') && signals.some((s) => s.archetype === 'stalemate-swindle');
      expect(both, `materialDiff=${materialDiff} produced both archetypes`).toBe(false);
    }
  });
});

describe('gate 0 authority', () => {
  it('does not fire when the game did not end in stalemate, however lopsided it was', () => {
    const { analysis, understanding } = stalemateGame({
      finalPly: WHITE_DELIVERS,
      materialDiff: 2000,
      evalBeforeCp: 2000,
      finalEvaluation: { kind: 'terminal', result: 'white-wins' }
    });
    const checkmateOutcome = unknownOutcome({
      result: '1-0',
      termination: 'checkmate',
      onBoard: true,
      finalEvaluation: { kind: 'terminal', result: 'white-wins' },
      source: 'engine-terminal',
      confidence: 1
    });
    const signals = buildArchetypeSignals(EMPTY_GAME, analysis, understanding, checkmateOutcome, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });

  it('does not fire for an off-board draw that merely claims stalemate', () => {
    const { analysis, understanding } = stalemateGame({ finalPly: WHITE_DELIVERS, materialDiff: 900, evalBeforeCp: 1200 });
    const offBoard = unknownOutcome({
      result: '1/2-1/2',
      termination: 'stalemate',
      onBoard: false,
      source: 'termination-tag',
      confidence: 0.9
    });
    const signals = buildArchetypeSignals(EMPTY_GAME, analysis, understanding, offBoard, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'stalemate-blunder')).toBeUndefined();
  });
});

describe('determinism', () => {
  it('is byte-identical across repeated calls', () => {
    const options = { finalPly: WHITE_DELIVERS, materialDiff: 900, evalBeforeCp: 1200 } as const;
    expect(signalsFor(options)).toEqual(signalsFor(options));
  });
});
