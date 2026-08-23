import { pieceIdFor } from '../pgn/pieceId';
import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameRecord, MoveRecord } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import { DEFAULT_STORY_SETTINGS, STORY_SCHEMA_VERSION } from '../story/types';
import type { ArchetypeSignal, BeatRole, StoryArchetype, StoryBeat, StoryPlan } from '../story/types';
import { buildStoryPlan } from '../story/buildStoryPlan';
import {
  analysisFrom,
  causeConsequence,
  evidence,
  forcedSequence,
  gameArc,
  plyAnalysis,
  plySemantics,
  plySignals,
  threatRecord,
  turningPoint,
  understandingFrom
} from '../story/storyFixtures';

/**
 * Test-only fixture builders for src/director/*.test.ts. Mirrors
 * story/storyFixtures.ts's own established style (direct object literals,
 * not a run through Phase 2.1/2.2/2.3's real detectors) and directly reuses
 * story/storyFixtures.ts rather than duplicating any of it. NOT a
 * *.test.ts file itself, so vitest never collects it as a suite on its own.
 */

const STANDARD_STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function moveRecord(ply: number, color: 'w' | 'b', pieceType: MoveRecord['pieceType'], from: string, to: string, san: string): MoveRecord {
  return {
    ply,
    san,
    from,
    to,
    color,
    pieceType,
    pieceId: pieceIdFor(color, pieceType, from),
    isEnPassant: false
  };
}

export function gameFromMoves(moves: readonly MoveRecord[], positionFens?: ReadonlyMap<number, string>): GameRecord {
  return {
    headers: {},
    positions: Array.from({ length: moves.length + 1 }, (_, i) => ({
      ply: i,
      fen: positionFens?.get(i) ?? `placeholder-fen-${i}`
    })),
    moves: [...moves]
  };
}

export function storyBeat(id: string, role: BeatRole, plies: readonly number[], overrides: Partial<StoryBeat> = {}): StoryBeat {
  return {
    id,
    role,
    plies,
    evidenceRefs: {},
    salience: 500,
    ...overrides
  };
}

export function archetypeSignal(
  archetype: StoryArchetype,
  plies: readonly number[],
  beatIds: readonly string[] = []
): ArchetypeSignal {
  return {
    archetype,
    plies,
    beatIds,
    evidence: evidence('chess-rule', plies, `fixture ${archetype}`)
  };
}

/** A minimal, syntactically valid, otherwise-empty StoryPlan — for narrow tests that hand-supply only the fields they care about. */
export function storyPlanFrom(overrides: Partial<StoryPlan> = {}): StoryPlan {
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    centralConflict: null,
    noConflictReason: 'no-turning-points',
    beats: [],
    moveTreatment: [],
    archetypeSignals: [],
    pieceContributions: [],
    explanationOpportunities: [],
    settings: DEFAULT_STORY_SETTINGS,
    ...overrides
  };
}

export interface DirectorScenario {
  readonly game: GameRecord;
  readonly analysis: GameAnalysis;
  readonly understanding: GameUnderstanding;
  readonly story: StoryPlan;
}

/**
 * A rich, real-buildStoryPlan()-produced scenario exercising all five
 * BeatRoles in one small game:
 *   ply 1 (setup, threat-refutation)
 *   ply 2-3 (building-sequence, multi-move-consequence)
 *   ply 4 (climax AND resolution — a forced-mate-delivery that ends the game,
 *          mirroring the real Scholar's Mate shape)
 *
 * StoryPlan itself is never hand-built here — only GameUnderstanding is
 * (via story/storyFixtures.ts's own helpers), and the real buildStoryPlan()
 * is called to produce a guaranteed internally-consistent StoryPlan, the
 * same discipline story/*.test.ts already established for GameUnderstanding
 * fixtures one layer down.
 */
export function richMateEndingScenario(): DirectorScenario {
  const moves = [
    moveRecord(1, 'w', 'p', 'd2', 'd4', 'd4'),
    moveRecord(2, 'b', 'n', 'g8', 'f6', 'Nf6'),
    moveRecord(3, 'w', 'b', 'c1', 'g5', 'Bg5'),
    moveRecord(4, 'b', 'q', 'd8', 'd4', 'Qxd4') // synthetic: the mating move
  ];
  const positionFens = new Map<number, string>([[4, STANDARD_STARTING_FEN]]);
  const game = gameFromMoves(moves, positionFens);

  const analysisPlies: PlyAnalysis[] = [
    plyAnalysis(1, { sideToMove: 'w', movePlayedSan: 'd4' }),
    plyAnalysis(2, { sideToMove: 'b', movePlayedSan: 'Nf6' }),
    plyAnalysis(3, { sideToMove: 'w', movePlayedSan: 'Bg5' }),
    plyAnalysis(4, {
      sideToMove: 'b',
      movePlayedSan: 'Qxd4',
      fenAfter: STANDARD_STARTING_FEN,
      evaluationAfter: { kind: 'terminal', result: 'black-wins' }
    })
  ];
  const analysis = analysisFrom(analysisPlies);

  const threat = threatRecord('threat-1', 1, 'w', 'mate-threat', 'e1', { refutedBy: { ply: 2, moveUci: 'g8f6' } });
  const seq = forcedSequence('seq-a', [2, 3], 'only-legal-reply');
  const cc4 = causeConsequence(4, {
    multiMoveConsequence: { sequenceId: 'seq-a', endPly: 4 },
    resolution: 'forced-mate'
  });
  const tp4 = turningPoint(4, 'forced-mate-delivery', cc4, 900, ['decisive-mate-transition']);

  const understanding = understandingFrom({
    plies: [
      plySemantics(1, plySignals(moves[0]!.pieceId)),
      plySemantics(2, plySignals(moves[1]!.pieceId)),
      plySemantics(3, plySignals(moves[2]!.pieceId)),
      plySemantics(4, plySignals(moves[3]!.pieceId, { deliversMate: true, isTurningPoint: true }))
    ],
    threats: [threat],
    sequences: [seq],
    turningPoints: [tp4]
  });

  const story = buildStoryPlan(game, analysis, understanding, DEFAULT_STORY_SETTINGS);

  return { game, analysis, understanding, story };
}

/** No turning points at all -> centralConflict: null, beats: [] — a quiet game. */
export function quietGameScenario(): DirectorScenario {
  const moves = [moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4'), moveRecord(2, 'b', 'p', 'e7', 'e5', 'e5')];
  const game = gameFromMoves(moves);
  const analysis = analysisFrom([plyAnalysis(1, { sideToMove: 'w' }), plyAnalysis(2, { sideToMove: 'b' })]);
  const understanding = understandingFrom({
    plies: [plySemantics(1, plySignals(moves[0]!.pieceId)), plySemantics(2, plySignals(moves[1]!.pieceId))]
  });
  const story = buildStoryPlan(game, analysis, understanding, DEFAULT_STORY_SETTINGS);
  return { game, analysis, understanding, story };
}

/**
 * No central conflict, but deliberately shaped so the REAL
 * classifyMoveTreatment() (story/retention.ts) — never hand-faked here —
 * genuinely labels ply 2 'pruned': quality 'optimal', no motif/threat/
 * sequence/archetype involvement, and past the (deliberately tiny)
 * openingEndPly=1 ceiling. Ply 1 stays within the opening ceiling
 * ('theory'); ply 3 carries a non-optimal qualityClass ('compressible'),
 * so this scenario also proves a normal-duration move immediately
 * following a zero-duration one still advances correctly.
 */
export function prunedPlyScenario(): DirectorScenario {
  const moves = [
    moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4'),
    moveRecord(2, 'b', 'p', 'e7', 'e5', 'e5'), // expected to classify as 'pruned'
    moveRecord(3, 'w', 'n', 'g1', 'f3', 'Nf3')
  ];
  // The real, standard 1.e4 e5 2.Nf3 FEN sequence (not placeholder text) —
  // this scenario is exercised through the real renderer in
  // tests/e2e/director.spec.ts, which needs genuinely parseable FENs.
  const positionFens = new Map<number, string>([
    [0, STANDARD_STARTING_FEN],
    [1, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'],
    [2, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'],
    [3, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2']
  ]);
  const game = gameFromMoves(moves, positionFens);
  const analysis = analysisFrom([
    plyAnalysis(1, { sideToMove: 'w' }),
    plyAnalysis(2, { sideToMove: 'b' }),
    plyAnalysis(3, { sideToMove: 'w' })
  ]);
  const understanding = understandingFrom({
    plies: [
      plySemantics(1, plySignals(moves[0]!.pieceId), { qualityClass: 'optimal' }),
      plySemantics(2, plySignals(moves[1]!.pieceId), { qualityClass: 'optimal' }),
      plySemantics(3, plySignals(moves[2]!.pieceId), { qualityClass: 'inaccuracy' })
    ],
    gameArc: gameArc(1, 3, [
      { ply: 1, materialDiff: 0 },
      { ply: 2, materialDiff: 0 },
      { ply: 3, materialDiff: 0 }
    ])
  });
  const story = buildStoryPlan(game, analysis, understanding, DEFAULT_STORY_SETTINGS);
  return { game, analysis, understanding, story };
}

/** Zero moves -> understanding.plies === [] -> buildStoryPlan's own empty-StoryPlan special case. */
export function zeroMoveScenario(): DirectorScenario {
  const game: GameRecord = { headers: {}, positions: [{ ply: 0, fen: STANDARD_STARTING_FEN }], moves: [] };
  const analysis = analysisFrom([]);
  const understanding = understandingFrom({ plies: [] });
  const story = buildStoryPlan(game, analysis, understanding, DEFAULT_STORY_SETTINGS);
  return { game, analysis, understanding, story };
}
