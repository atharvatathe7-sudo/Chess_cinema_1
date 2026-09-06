import { describe, expect, it } from 'vitest';
import { pieceIdFor } from '../pgn/pieceId';
import type { GameUnderstanding, KingMobilityRecord, PlySemantics } from '../understanding/types';
import { gameFromMoves, moveRecord } from './directorFixtures';
import { deriveTrackingDirectives, pieceSquareAtPly } from './tracking';
import type { CameraDirective } from './types';

/**
 * Phase 18D Batch 1 — pieceSquareAtPly is pure occupancy bookkeeping over
 * GameRecord.moves (never FEN scanning for identity), and
 * deriveTrackingDirectives is the one subject-selection decision, made from
 * already-verified evidence only. Every fixture here hand-supplies exactly
 * the moves/facts a test needs, the same discipline directorFixtures.ts's
 * other consumers already follow.
 */

const WHITE_KING = pieceIdFor('w', 'k', 'e1');
const BLACK_KING = pieceIdFor('b', 'k', 'e8');
const WHITE_KNIGHT_G1 = pieceIdFor('w', 'n', 'g1');
const WHITE_PAWN_E2 = pieceIdFor('w', 'p', 'e2');
const BLACK_PAWN_D7 = pieceIdFor('b', 'p', 'd7');
const WHITE_ROOK_H1 = pieceIdFor('w', 'r', 'h1');
const WHITE_PAWN_A2 = pieceIdFor('w', 'p', 'a2');

describe('pieceSquareAtPly', () => {
  it('returns the starting square before any moves', () => {
    const game = gameFromMoves([]);
    expect(pieceSquareAtPly(game, WHITE_KING, 0)).toBe('e1');
  });

  it('resolves normal movement', () => {
    const game = gameFromMoves([moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4', { pieceId: WHITE_PAWN_E2 })]);
    expect(pieceSquareAtPly(game, WHITE_PAWN_E2, 0)).toBe('e2');
    expect(pieceSquareAtPly(game, WHITE_PAWN_E2, 1)).toBe('e4');
  });

  it('resolves multiple moves of the same piece', () => {
    const game = gameFromMoves([
      moveRecord(1, 'w', 'n', 'g1', 'f3', 'Nf3', { pieceId: WHITE_KNIGHT_G1 }),
      moveRecord(2, 'b', 'p', 'e7', 'e5', 'e5'),
      moveRecord(3, 'w', 'n', 'f3', 'e5', 'Nxe5', { pieceId: WHITE_KNIGHT_G1, capturedPieceId: pieceIdFor('b', 'p', 'e7') })
    ]);
    expect(pieceSquareAtPly(game, WHITE_KNIGHT_G1, 1)).toBe('f3');
    expect(pieceSquareAtPly(game, WHITE_KNIGHT_G1, 2)).toBe('f3');
    expect(pieceSquareAtPly(game, WHITE_KNIGHT_G1, 3)).toBe('e5');
  });

  it('returns null from the ply a piece is captured onward, never before', () => {
    const capturedId = BLACK_PAWN_D7;
    const game = gameFromMoves([
      moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4', { pieceId: WHITE_PAWN_E2 }),
      moveRecord(2, 'b', 'p', 'd7', 'd5', 'd5', { pieceId: capturedId }),
      moveRecord(3, 'w', 'p', 'e4', 'd5', 'exd5', { pieceId: WHITE_PAWN_E2, capturedPieceId: capturedId }),
      moveRecord(4, 'b', 'p', 'g7', 'g6', 'g6')
    ]);
    expect(pieceSquareAtPly(game, capturedId, 2)).toBe('d5');
    expect(pieceSquareAtPly(game, capturedId, 3)).toBeNull();
    expect(pieceSquareAtPly(game, capturedId, 4)).toBeNull();
  });

  it('preserves identity through promotion — the same PieceId resolves before and after', () => {
    const game = gameFromMoves([
      moveRecord(1, 'w', 'p', 'a7', 'a8', 'a8=Q', { pieceId: WHITE_PAWN_A2, promotion: 'q' })
    ]);
    expect(pieceSquareAtPly(game, WHITE_PAWN_A2, 0)).toBe('a2');
    expect(pieceSquareAtPly(game, WHITE_PAWN_A2, 1)).toBe('a8');
  });

  it('resolves castling correctly for both the king and the paired rook', () => {
    const game = gameFromMoves([
      moveRecord(1, 'w', 'k', 'e1', 'g1', 'O-O', {
        castle: 'king',
        rookMove: { pieceId: WHITE_ROOK_H1, from: 'h1', to: 'f1' }
      })
    ]);
    expect(pieceSquareAtPly(game, WHITE_KING, 1)).toBe('g1');
    expect(pieceSquareAtPly(game, WHITE_ROOK_H1, 0)).toBe('h1');
    expect(pieceSquareAtPly(game, WHITE_ROOK_H1, 1)).toBe('f1');
  });

  it('throws deterministically for a PieceId that is not a real starting piece', () => {
    const game = gameFromMoves([]);
    expect(() => pieceSquareAtPly(game, 'w-q-a5', 0)).toThrow(/not a piece from a standard starting position/);
  });
});

function plySemantics(ply: number, opts: { deliversCheck?: boolean; deliversMate?: boolean; pieceId?: string } = {}): PlySemantics {
  return {
    ply,
    qualityClass: 'optimal',
    signals: {
      matchesEngineBest: true,
      isSacrifice: false,
      deliversCheck: opts.deliversCheck ?? false,
      deliversMate: opts.deliversMate ?? false,
      motifIds: [],
      isTurningPoint: false,
      pieceId: opts.pieceId ?? WHITE_PAWN_E2,
      isPromotion: false,
      isUnderpromotion: false
    },
    evidence: { basis: 'chess-rule', sourcePlies: [ply], note: 'fixture' }
  };
}

function understandingFrom(plies: readonly PlySemantics[], kingMobility: readonly KingMobilityRecord[] = []): GameUnderstanding {
  return {
    schemaVersion: 1,
    plies,
    motifs: [],
    threats: [],
    sequences: [],
    turningPoints: [],
    kingMobility,
    gameArc: { openingEndPly: 0, middlegameEndPly: 0, materialTrajectory: [], evidence: { basis: 'chess-rule', sourcePlies: [], note: '' } },
    narrativeSignals: [],
    settings: {
      engineBudget: { maxFollowUpPositions: 0, multiPvLines: 0, multiPvDepth: 0, multiPvMaxTimeMsPerPosition: 0, deepVerifyDepth: 0, deepVerifyMaxTimeMsPerPosition: 0 },
      minMaterialValueForMotif: 320,
      equivalenceEpsilonCp: 30
    }
  };
}

function cameraDirective(overrides: Partial<CameraDirective> & { atPly: number; untilPly: number }): CameraDirective {
  return {
    role: 'critical',
    zoom: 1.5,
    squares: [],
    evidenceRef: { kind: 'beat', id: 'beat-x' },
    ...overrides
  };
}

describe('deriveTrackingDirectives', () => {
  it('selects the single mover as the subject when nothing delivers check', () => {
    const game = gameFromMoves([moveRecord(5, 'w', 'q', 'd1', 'd8', 'Qd8', { pieceId: pieceIdFor('w', 'q', 'd1') })]);
    const understanding = understandingFrom([plySemantics(5, { pieceId: pieceIdFor('w', 'q', 'd1') })]);
    const directives = deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 5, role: 'critical' })]);

    expect(directives).toHaveLength(1);
    expect(directives[0]!.subject).toEqual({ kind: 'piece', pieceId: pieceIdFor('w', 'q', 'd1') });
    expect(directives[0]!.evidenceRef).toEqual({ kind: 'move', ply: 5 });
  });

  it('selects the checked/mated king as the subject when the move delivers check', () => {
    const mover = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([moveRecord(5, 'w', 'q', 'd1', 'e8', 'Qe8#', { pieceId: mover })]);
    const understanding = understandingFrom([plySemantics(5, { deliversMate: true, pieceId: mover })]);
    const directives = deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 5, role: 'critical' })]);

    expect(directives).toHaveLength(1);
    expect(directives[0]!.subject).toEqual({ kind: 'piece', pieceId: BLACK_KING });
    expect(directives[0]!.evidenceRef).toEqual({ kind: 'king-safety', ply: 5 });
  });

  it('deterministically prefers the checked king over the mover even though both would qualify', () => {
    const mover = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([moveRecord(5, 'w', 'q', 'd1', 'h5', 'Qh5+', { pieceId: mover })]);
    const understanding = understandingFrom([plySemantics(5, { deliversCheck: true, pieceId: mover })]);
    const directives = deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 5, role: 'critical' })]);

    expect(directives).toHaveLength(1);
    expect(directives[0]!.subject.pieceId).toBe(BLACK_KING);
    expect(directives[0]!.priority).toBeLessThan(1); // king-safety (0) outranks move (1)
  });

  it('produces at most one TrackingDirective per CameraDirective', () => {
    const mover = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([
      moveRecord(5, 'w', 'q', 'd1', 'd7', 'Qd7', { pieceId: mover }),
      moveRecord(6, 'b', 'k', 'e8', 'f8', 'Kf8'),
      moveRecord(7, 'w', 'q', 'd7', 'd8', 'Qd8+', { pieceId: mover })
    ]);
    const understanding = understandingFrom([
      plySemantics(5, { pieceId: mover }),
      plySemantics(6, { pieceId: pieceIdFor('b', 'k', 'e8') }),
      plySemantics(7, { deliversCheck: true, pieceId: mover })
    ]);
    const directives = deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 7, role: 'consequence' })]);
    expect(directives).toHaveLength(1);
  });

  it('bounds fromPly/toPly to exactly the owning CameraDirective span', () => {
    // A real multi-ply span always alternates colors (chess never lets one
    // side move twice running), so the ONLY subject that can honestly span
    // more than one ply is the king-safety case: the same checked king
    // resolves throughout, even though a DIFFERENT piece (and the king's own
    // escape) moves each ply. This is why moverCandidate — deliberately —
    // can only ever apply to a single-ply span; see its own doc comment.
    const attacker = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([
      moveRecord(5, 'w', 'q', 'd1', 'd7', 'Qd7+', { pieceId: attacker }),
      moveRecord(6, 'b', 'k', 'e8', 'f8', 'Kf8'),
      moveRecord(7, 'w', 'q', 'd7', 'd8', 'Qd8+', { pieceId: attacker })
    ]);
    const understanding = understandingFrom([
      plySemantics(5, { deliversCheck: true, pieceId: attacker }),
      plySemantics(6, { pieceId: pieceIdFor('b', 'k', 'e8') }),
      plySemantics(7, { deliversCheck: true, pieceId: attacker })
    ]);
    const directives = deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 7, role: 'consequence' })]);

    expect(directives).toHaveLength(1);
    expect(directives[0]!.subject.pieceId).toBe(BLACK_KING);
    expect(directives[0]!.fromPly).toBe(5);
    expect(directives[0]!.toPly).toBe(7);
  });

  it('abstains — never switches subjects mid-shot — when the span has no single constant mover and nothing delivers check', () => {
    const game = gameFromMoves([
      moveRecord(5, 'w', 'q', 'd1', 'd7', 'Qd7', { pieceId: pieceIdFor('w', 'q', 'd1') }),
      moveRecord(6, 'b', 'r', 'a8', 'd8', 'Rd8')
    ]);
    const understanding = understandingFrom([plySemantics(5, { pieceId: pieceIdFor('w', 'q', 'd1') }), plySemantics(6, { pieceId: pieceIdFor('b', 'r', 'a8') })]);
    const directives = deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 6, role: 'consequence' })]);
    expect(directives).toEqual([]);
  });

  it('never tracks an establish or payoff span in Batch 1', () => {
    const mover = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([moveRecord(5, 'w', 'q', 'd1', 'd8', 'Qd8', { pieceId: mover })]);
    const understanding = understandingFrom([plySemantics(5, { pieceId: mover })]);

    expect(deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 5, role: 'establish' })])).toEqual([]);
    expect(deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 5, role: 'payoff' })])).toEqual([]);
  });

  it('produces nothing when a directive has no real moves in its own ply range', () => {
    const game = gameFromMoves([]);
    const understanding = understandingFrom([]);
    expect(deriveTrackingDirectives(game, understanding, [cameraDirective({ atPly: 5, untilPly: 5, role: 'critical' })])).toEqual([]);
  });
});
