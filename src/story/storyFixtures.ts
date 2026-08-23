import type { Color } from '../chess/ChessEngine';
import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameRecord, MoveRecord } from '../pgn/types';
import { pieceIdFor } from '../pgn/pieceId';
import type {
  BestAlternativeRecord,
  CauseConsequenceRecord,
  Evidence,
  ForcedSequence,
  GameArcSummary,
  GameUnderstanding,
  KingMobilityRecord,
  NarrativeArchetypeSignal,
  PlySemantics,
  PlySignals,
  TacticalMotifInstance,
  ThreatRecord,
  TurningPoint,
  TurningPointKind,
  UnderstandingSettings
} from '../understanding/types';
import { DEFAULT_UNDERSTANDING_SETTINGS, UNDERSTANDING_SCHEMA_VERSION } from '../understanding/types';

/**
 * Test-only fixture builders shared across src/story/*.test.ts. NOT a
 * *.test.ts file itself (vitest.config.ts only collects src/**\/*.test.ts),
 * so this never runs as a suite on its own. Mirrors the hand-built-fixture
 * style already established by understanding/understandGame.test.ts and
 * understanding/causeConsequence.test.ts — direct object literals, not a
 * run through Phase 2.2's own detectors, so story/ tests stay focused on
 * story/'s own logic given arbitrary valid-shaped inputs.
 */

export function evidence(basis: Evidence['basis'], sourcePlies: readonly number[], note: string, confidence?: number): Evidence {
  return { basis, sourcePlies, note, ...(confidence !== undefined ? { confidence } : {}) };
}

export function move(ply: number, overrides: Partial<MoveRecord> = {}): MoveRecord {
  const color: Color = ply % 2 === 1 ? 'w' : 'b';
  return {
    ply,
    san: `m${ply}`,
    from: 'a2',
    to: 'a3',
    color,
    pieceType: 'p',
    pieceId: pieceIdFor(color, 'p', 'a2'),
    isEnPassant: false,
    ...overrides
  };
}

export function gameFrom(moves: readonly MoveRecord[]): GameRecord {
  return {
    headers: {},
    positions: Array.from({ length: moves.length + 1 }, (_, i) => ({ ply: i, fen: `placeholder-fen-${i}` })),
    moves: [...moves]
  };
}

export function plyAnalysis(ply: number, overrides: Partial<PlyAnalysis> = {}): PlyAnalysis {
  const sideToMove: Color = ply % 2 === 1 ? 'w' : 'b';
  return {
    ply,
    moveNumber: Math.ceil(ply / 2),
    sideToMove,
    movePlayedSan: `m${ply}`,
    movePlayedUci: 'a2a3',
    fenBefore: `placeholder-fen-${ply - 1}`,
    fenAfter: `placeholder-fen-${ply}`,
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: 'a2a3',
    principalVariation: ['a2a3'],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

export function analysisFrom(plies: readonly PlyAnalysis[]): GameAnalysis {
  return { plies: [...plies], candidates: [], settings: { depth: 12, maxTimeMsPerPosition: 3000 } };
}

export function plySignals(pieceId: string, overrides: Partial<PlySignals> = {}): PlySignals {
  return {
    matchesEngineBest: true,
    isSacrifice: false,
    deliversCheck: false,
    deliversMate: false,
    motifIds: [],
    isTurningPoint: false,
    pieceId,
    isPromotion: false,
    isUnderpromotion: false,
    ...overrides
  };
}

export function plySemantics(ply: number, signals: PlySignals, overrides: Partial<PlySemantics> = {}): PlySemantics {
  return {
    ply,
    qualityClass: 'optimal',
    signals,
    evidence: evidence('engine-eval', [ply], 'fixture'),
    ...overrides
  };
}

export function bestAlternative(overrides: Partial<BestAlternativeRecord> = {}): BestAlternativeRecord {
  return {
    topMove: { uci: 'a2a3', principalVariation: ['a2a3'] },
    topMoveEvaluation: { kind: 'cp', cp: 0 },
    playedMoveWasTopMove: true,
    playedMoveEffectivelyEquivalent: true,
    bestMoveUniqueness: 'unknown',
    alternativesConsidered: [],
    evidence: evidence('engine-eval', [1], 'fixture'),
    ...overrides
  };
}

export function causeConsequence(ply: number, overrides: Partial<CauseConsequenceRecord> = {}): CauseConsequenceRecord {
  return {
    id: `cc-${ply}`,
    ply,
    positionBefore: `placeholder-fen-${ply - 1}`,
    movePlayed: { san: `m${ply}`, uci: 'a2a3' },
    immediateChange: {
      evaluationDelta: { swingCp: 0, swingForMoverCp: 0 },
      materialDelta: 0,
      motifsTriggered: []
    },
    threatsCreated: [],
    threatsRemoved: [],
    mechanism: null,
    bestAlternative: bestAlternative(),
    evaluationConsequence: { atPly: ply, swingCp: 0 },
    materialConsequence: { atPly: ply, netMaterialChange: 0 },
    resolution: 'unresolved',
    evidence: evidence('engine-eval', [ply], 'fixture'),
    ...overrides
  };
}

export function turningPoint(
  ply: number,
  kind: TurningPointKind,
  cc: CauseConsequenceRecord,
  score: number,
  reasons: TurningPoint['significance']['reasons'] = []
): TurningPoint {
  return {
    id: `tp-${ply}`,
    ply,
    kind,
    significance: { score, reasons },
    causeConsequence: cc
  };
}

export function forcedSequence(
  id: string,
  plies: readonly number[],
  forcingReason: ForcedSequence['forcingReason'] = 'check'
): ForcedSequence {
  return {
    id,
    startPly: plies[0]!,
    endPly: plies[plies.length - 1]!,
    plies: [...plies],
    forcingReason,
    evidence: evidence('chess-rule', plies, `forced chain starting with ${forcingReason}`)
  };
}

export function threatRecord(
  id: string,
  ply: number,
  side: Color,
  kind: ThreatRecord['kind'],
  targetSquare: string,
  overrides: Partial<ThreatRecord> = {}
): ThreatRecord {
  return {
    id,
    ply,
    side,
    kind,
    targetSquare,
    evidence: evidence('chess-rule', [ply], 'fixture threat'),
    ...overrides
  };
}

export function tacticalMotif(
  id: string,
  ply: number,
  motif: TacticalMotifInstance['motif'],
  attacker: string,
  targets: readonly string[]
): TacticalMotifInstance {
  return {
    id,
    ply,
    motif,
    squares: { attacker, targets },
    geometryEvidence: evidence('chess-rule', [ply], 'fixture motif')
  };
}

export function kingMobility(ply: number, color: Color, squares: readonly string[]): KingMobilityRecord {
  return { ply, color, legalEscapeSquares: squares, legalEscapeSquareCount: squares.length };
}

export function gameArc(
  openingEndPly: number,
  middlegameEndPly: number,
  materialTrajectory: readonly { readonly ply: number; readonly materialDiff: number }[]
): GameArcSummary {
  return {
    openingEndPly,
    middlegameEndPly,
    materialTrajectory,
    evidence: evidence('chess-rule', materialTrajectory.map((t) => t.ply), 'fixture arc')
  };
}

export interface UnderstandingFixtureInputs {
  readonly plies: readonly PlySemantics[];
  readonly motifs?: readonly TacticalMotifInstance[];
  readonly threats?: readonly ThreatRecord[];
  readonly sequences?: readonly ForcedSequence[];
  readonly turningPoints?: readonly TurningPoint[];
  readonly kingMobility?: readonly KingMobilityRecord[];
  readonly gameArc?: GameArcSummary;
  readonly narrativeSignals?: readonly NarrativeArchetypeSignal[];
  readonly settings?: UnderstandingSettings;
}

export function understandingFrom(inputs: UnderstandingFixtureInputs): GameUnderstanding {
  return {
    schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
    plies: inputs.plies,
    motifs: inputs.motifs ?? [],
    threats: inputs.threats ?? [],
    sequences: inputs.sequences ?? [],
    turningPoints: inputs.turningPoints ?? [],
    kingMobility: inputs.kingMobility ?? [],
    gameArc: inputs.gameArc ?? gameArc(0, 0, []),
    narrativeSignals: inputs.narrativeSignals ?? [],
    settings: inputs.settings ?? DEFAULT_UNDERSTANDING_SETTINGS
  };
}
