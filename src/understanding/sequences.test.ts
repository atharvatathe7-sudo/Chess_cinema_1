import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import { detectForcedSequences, forcingReasonForReply } from './sequences';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'x',
    movePlayedUci: 'a1a2',
    fenBefore: '7k/8/8/8/8/8/8/K7 w - - 0 1',
    fenAfter: '7k/8/8/8/8/8/8/K7 b - - 0 1',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: null,
    principalVariation: [],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

describe('forcingReasonForReply', () => {
  it('detects check as the forcing reason', () => {
    const mover = ply({ ply: 1, fenAfter: '4k3/8/8/8/8/8/8/4R2K b - - 0 1' });
    const reply = ply({ ply: 2, movePlayedUci: 'e8d8' });
    expect(forcingReasonForReply(mover, reply)).toBe('check');
  });

  it('detects a single legal reply as forcing even without check', () => {
    const mover = ply({ ply: 1, fenAfter: 'k7/8/1K6/8/8/8/8/8 b - - 0 1' });
    const reply = ply({ ply: 2, movePlayedUci: 'a8b8' });
    expect(forcingReasonForReply(mover, reply)).toBe('only-legal-reply');
  });

  it('detects a direct recapture on the same square as forcing', () => {
    const mover = ply({ ply: 1, movePlayedUci: 'e1e5', fenAfter: '7k/8/3p4/4R3/8/8/8/7K b - - 0 1' });
    const reply = ply({ ply: 2, movePlayedUci: 'd6e5' });
    expect(forcingReasonForReply(mover, reply)).toBe('material-forced-recapture');
  });

  it('returns null when nothing forces the reply', () => {
    const mover = ply({ ply: 1, movePlayedUci: 'a1a2', fenAfter: '7k/8/8/8/8/8/8/K7 b - - 0 1' });
    const reply = ply({ ply: 2, movePlayedUci: 'h8g8' });
    expect(forcingReasonForReply(mover, reply)).toBeNull();
  });
});

describe('detectForcedSequences', () => {
  it('chains consecutive forced links into one sequence', () => {
    const plies = [
      ply({ ply: 1, movePlayedUci: 'e1e5', fenAfter: '7k/8/3p4/4R3/8/8/8/7K b - - 0 1' }),
      ply({ ply: 2, movePlayedUci: 'd6e5', fenAfter: '7k/8/8/4p3/8/8/8/7K w - - 0 1' }),
      ply({ ply: 3, movePlayedUci: 'a1a2', fenAfter: '7k/8/8/4p3/8/8/P7/7K b - - 0 1' })
    ];
    const sequences = detectForcedSequences(plies);
    expect(sequences).toHaveLength(1);
    expect(sequences[0]!.startPly).toBe(1);
    expect(sequences[0]!.endPly).toBe(2);
    expect(sequences[0]!.plies).toEqual([1, 2]);
    expect(sequences[0]!.forcingReason).toBe('material-forced-recapture');
  });

  it('produces no sequence when nothing is forced anywhere', () => {
    const plies = [
      ply({ ply: 1, movePlayedUci: 'a1a2', fenAfter: '7k/8/8/8/8/8/8/K7 b - - 0 1' }),
      ply({ ply: 2, movePlayedUci: 'h8g8', fenAfter: '6k1/8/8/8/8/8/8/K7 w - - 0 1' })
    ];
    expect(detectForcedSequences(plies)).toEqual([]);
  });

  it('is deterministic across repeated runs', () => {
    const plies = [
      ply({ ply: 1, fenAfter: '4k3/8/8/8/8/8/8/4R2K b - - 0 1' }),
      ply({ ply: 2, movePlayedUci: 'e8d8' })
    ];
    expect(detectForcedSequences(plies)).toEqual(detectForcedSequences(plies));
  });
});
