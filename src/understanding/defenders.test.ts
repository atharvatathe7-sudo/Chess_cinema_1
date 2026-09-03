import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { PlyAnalysis } from '../analysis/types';
import { detectDefenderLoss } from './defenders';

/**
 * Phase 16 (MUST HAVE 8) — constructed-board tests for the defender-removal
 * primitive.
 *
 * Every fixture is a real, legal position built from an explicit FEN and a
 * real legal move played through chess.js, so fenBefore/fenAfter are genuine
 * board states rather than hand-written strings that might not correspond to
 * any reachable position. No game ID, SAN from a benchmark, or corpus FEN
 * appears here — these are minimal constructed positions chosen to isolate one
 * rule each.
 */

function plyFrom(fen: string, moveUci: string, ply = 1): PlyAnalysis {
  const chess = new Chess(fen);
  const from = moveUci.slice(0, 2);
  const to = moveUci.slice(2, 4);
  const promotion = moveUci.length > 4 ? moveUci.slice(4, 5) : undefined;
  const move = chess.move(promotion ? { from, to, promotion } : { from, to });
  if (!move) throw new Error(`illegal fixture move ${moveUci} in ${fen}`);
  return {
    ply,
    moveNumber: Math.ceil(ply / 2),
    sideToMove: move.color,
    movePlayedSan: move.san,
    movePlayedUci: moveUci,
    fenBefore: fen,
    fenAfter: chess.fen(),
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: moveUci,
    principalVariation: [moveUci],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12
  };
}

describe('detectDefenderLoss — positive cases', () => {
  it('capturing the sole defender of a piece reports the target that became winnable', () => {
    // White rook on d1 attacks the black knight on d5. The knight is defended
    // exactly once, by the bishop on e6. White plays Bxe6, removing that
    // defender: d5 goes from defended-once to undefended, and from
    // not-profitably-takeable to takeable.
    const fen = '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1';
    const [record, ...rest] = detectDefenderLoss(plyFrom(fen, 'h3e6'));

    expect(rest).toEqual([]);
    expect(record).toBeDefined();
    expect(record!.defenderSquare).toBe('e6');
    expect(record!.defenderType).toBe('b');
    expect(record!.defendingSide).toBe('b');
    expect(record!.targetSquare).toBe('d5');
    expect(record!.targetType).toBe('n');
    expect(record!.defendersBefore).toBe(1);
    expect(record!.defendersAfter).toBe(0);
    expect(record!.seeBefore).toBeLessThanOrEqual(0);
    expect(record!.seeAfter).toBeGreaterThan(0);
  });

  it('moving your OWN defender away reports the piece you left hanging', () => {
    // The self-inflicted shape. The black knight on d5 is attacked by the
    // white rook on d1 and defended only by the bishop on e6. Black moves that
    // bishop to h3, abandoning d5.
    const fen = '4k3/8/4b3/3n4/8/8/8/3RK3 b - - 0 1';
    const records = detectDefenderLoss(plyFrom(fen, 'e6h3', 2));

    expect(records).toHaveLength(1);
    expect(records[0]!.defenderSquare).toBe('e6');
    expect(records[0]!.defendingSide).toBe('b');
    expect(records[0]!.targetSquare).toBe('d5');
    expect(records[0]!.defendersBefore).toBe(1);
    expect(records[0]!.defendersAfter).toBe(0);
    expect(records[0]!.seeAfter).toBeGreaterThan(0);
  });

  it('carries chess-rule evidence naming the target, the defender count, and the SEE change', () => {
    const fen = '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1';
    const [record] = detectDefenderLoss(plyFrom(fen, 'h3e6'));
    expect(record!.evidence.basis).toBe('chess-rule');
    expect(record!.evidence.sourcePlies).toEqual([1]);
    expect(record!.evidence.note).toContain('d5');
    expect(record!.evidence.note).toContain('1->0');
  });
});

describe('detectDefenderLoss — negative cases', () => {
  it('a capture that removes no defender produces nothing', () => {
    // The core discipline: "a piece was captured" is NOT defender-lost. The
    // black knight on a5 defends nothing of Black's, and nothing else on the
    // board changes defensive state.
    const fen = '4k3/8/8/n7/8/8/8/R3K3 w - - 0 1';
    expect(detectDefenderLoss(plyFrom(fen, 'a1a5'))).toEqual([]);
  });

  it('losing one of several adequate defenders produces nothing', () => {
    // The black pawn on d5 is attacked once (rook d1) and defended twice
    // (bishop e6, knight f6). Black walks one defender away; d5 is still
    // adequately defended, so the defensive state did not meaningfully
    // collapse and no record may be emitted for it.
    const fen = '4k3/8/4bn2/3p4/8/8/8/3RK3 b - - 0 1';
    const records = detectDefenderLoss(plyFrom(fen, 'e6h3', 2));
    expect(records.every((r) => r.targetSquare !== 'd5')).toBe(true);
  });

  it('a defender leaving a target that was ALREADY winnable produces nothing', () => {
    // The target must go from safe to takeable. Here d5 is attacked twice
    // (rook d1, bishop h1) and defended once, so it was already losing
    // material before the move — the defender leaving creates no new fact.
    const fen = '4k3/8/4b3/3n4/8/8/8/3RK2B b - - 0 1';
    const records = detectDefenderLoss(plyFrom(fen, 'e6g4', 2));
    expect(records.every((r) => r.targetSquare !== 'd5')).toBe(true);
  });

  it('a quiet move that defends nothing and abandons nothing produces nothing', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    expect(detectDefenderLoss(plyFrom(fen, 'e2e4'))).toEqual([]);
  });

  it('the king is never reported as a defended target', () => {
    // The black queen on d7 geometrically "defends" both the king on e8 and
    // the knight on c6. When it leaves, c6 genuinely collapses and IS
    // reported — proving this assertion is selective, not vacuous — while the
    // king, which is never won by exchange, must not be reported at all.
    const fen = '4k3/3q4/2n5/8/8/8/8/2R1K3 b - - 0 1';
    const records = detectDefenderLoss(plyFrom(fen, 'd7h3', 2));
    expect(records.map((r) => r.targetSquare)).toEqual(['c6']);
    expect(records.every((r) => r.targetType !== 'k')).toBe(true);
  });

  it('returns an empty array for an unreadable position rather than throwing', () => {
    const broken: PlyAnalysis = { ...plyFrom('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e2e4'), fenBefore: 'not-a-fen' };
    expect(detectDefenderLoss(broken)).toEqual([]);
  });
});

describe('detectDefenderLoss — determinism', () => {
  it('is byte-identical across repeated calls on the same ply', () => {
    const ply = plyFrom('4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1', 'h3e6');
    expect(detectDefenderLoss(ply)).toEqual(detectDefenderLoss(ply));
  });
});
