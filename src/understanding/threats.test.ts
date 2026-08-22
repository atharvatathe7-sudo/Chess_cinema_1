import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import {
  attachRefutations,
  detectThreats,
  detectThreatsForPly,
  findCheckAndMateThreats,
  findMaterialWinningThreats,
  findPositionalRestrictionThreats
} from './threats';
import { boardFromFen } from './geometry';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'Re1',
    movePlayedUci: 'e2e1',
    fenBefore: '7k/8/8/8/8/8/4R3/7K w - - 0 1',
    fenAfter: '7k/8/8/8/8/8/8/4R2K b - - 0 1',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: 'e2e1',
    principalVariation: ['e2e1'],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

describe('findMaterialWinningThreats', () => {
  it('reports an undefended enemy piece as a material-winning threat', () => {
    const board = boardFromFen('7k/8/8/4p3/8/8/8/4R2K w - - 0 1');
    const threats = findMaterialWinningThreats(board, 'w');
    expect(threats).toHaveLength(1);
    expect(threats[0]!.targetSquare).toBe('e5');
    expect(threats[0]!.netMaterialIfExecuted).toBe(100);
  });

  it('does not report a trivial attack on an adequately defended pawn', () => {
    const board = boardFromFen('7k/8/3p4/4p3/8/8/8/4R2K w - - 0 1');
    const threats = findMaterialWinningThreats(board, 'w');
    expect(threats.find((t) => t.targetSquare === 'e5')).toBeUndefined();
  });
});

describe('findCheckAndMateThreats', () => {
  it('finds a check threat one move away', () => {
    // White rook on e1 does not yet check the king on e8 (blocked)... use an open-file threat instead.
    const threats = findCheckAndMateThreats('4k3/8/8/8/8/8/8/4R2K b - - 0 1', 'w');
    expect(threats.some((t) => t.kind === 'check-threat' || t.kind === 'mate-threat')).toBe(true);
  });

  it('finds a genuine mate-in-1 threat', () => {
    // Kh8 boxed in by its own pawns; Re8 is mate. Confirm the threat is detected before the move is played.
    const threats = findCheckAndMateThreats('6k1/5ppp/8/8/8/8/8/4R2K b - - 0 1', 'w');
    expect(threats.some((t) => t.kind === 'mate-threat')).toBe(true);
  });

  it('finds nothing when the attacking side has no forcing move available', () => {
    const threats = findCheckAndMateThreats('7k/8/8/8/8/8/8/7K b - - 0 1', 'w');
    expect(threats).toEqual([]);
  });
});

describe('findPositionalRestrictionThreats', () => {
  it('reports a trapped, attacked piece with zero legal squares', () => {
    // Black knight on a8, boxed in by its own pawns on b6/c7 (its only two
    // squares), attacked by a white rook on the open a-file.
    const fen = 'n3k3/2p5/1p6/8/8/8/8/R6K b - - 0 1';
    const threats = findPositionalRestrictionThreats(fen, 'w');
    expect(threats.some((t) => t.targetSquare === 'a8')).toBe(true);
    expect(threats[0]!.basis).toBe('inference');
    expect(threats[0]!.confidence).toBeLessThan(1);
  });

  it('returns nothing when it is not the defending side to move', () => {
    const fen = 'n3k3/2p5/1p6/8/8/8/8/R6K w - - 0 1';
    expect(findPositionalRestrictionThreats(fen, 'w')).toEqual([]);
  });
});

describe('detectThreatsForPly / attachRefutations / detectThreats', () => {
  it('produces stable, distinct ids for a ply', () => {
    const p = ply({ fenAfter: '7k/8/8/4p3/8/8/8/4R2K b - - 0 1' });
    const a = detectThreatsForPly(p);
    const b = detectThreatsForPly(p);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
    expect(new Set(a.map((t) => t.id)).size).toBe(a.length);
  });

  it('attaches refutedBy when the next ply moves the threatened piece away', () => {
    const p1 = ply({ ply: 1, sideToMove: 'w', fenAfter: '7k/8/8/4p3/8/8/8/4R2K b - - 0 1' });
    const p2 = ply({
      ply: 2,
      sideToMove: 'b',
      movePlayedUci: 'e5e6',
      fenBefore: p1.fenAfter,
      fenAfter: '7k/8/4p3/8/8/8/8/4R2K w - - 0 1'
    });
    const threats = detectThreats([p1, p2]);
    const materialThreat = threats.find((t) => t.kind === 'material-winning-threat' && t.targetSquare === 'e5');
    expect(materialThreat?.refutedBy).toEqual({ ply: 2, moveUci: 'e5e6' });
  });

  it('leaves refutedBy unset when the reply does not address the threat', () => {
    const p1 = ply({ ply: 1, sideToMove: 'w', fenAfter: '7k/8/8/4p3/8/8/8/4R2K b - - 0 1' });
    const p2 = ply({
      ply: 2,
      sideToMove: 'b',
      movePlayedUci: 'h8g8',
      fenBefore: p1.fenAfter,
      fenAfter: '6k1/8/8/4p3/8/8/8/4R2K w - - 0 1'
    });
    const threats = attachRefutations(detectThreatsForPly(p1), [p1, p2]);
    const materialThreat = threats.find((t) => t.kind === 'material-winning-threat' && t.targetSquare === 'e5');
    expect(materialThreat?.refutedBy).toBeUndefined();
  });
});
