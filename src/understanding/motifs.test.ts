import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import { confirmMotifSignificance, detectMotifs, detectMotifsForPly } from './motifs';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'Nb6',
    movePlayedUci: 'd5b6',
    fenBefore: '8/8/8/3N4/8/8/8/8 w - - 0 1',
    fenAfter: 'k1q5/8/1N6/8/8/8/8/K7 b - - 0 1',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 300 },
    bestMove: 'd5b6',
    principalVariation: ['d5b6'],
    swingCp: 300,
    swingForMoverCp: 300,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

describe('detectMotifsForPly', () => {
  it('detects a fork after the move that creates one', () => {
    const instances = detectMotifsForPly(ply({}), 320);
    const fork = instances.find((m) => m.motif === 'fork');
    expect(fork).toBeDefined();
    expect(fork!.squares.attacker).toBe('b6');
    expect([...fork!.squares.targets].sort()).toEqual(['a8', 'c8']);
    expect(fork!.geometryEvidence.basis).toBe('chess-rule');
    expect(fork!.significanceEvidence).toBeUndefined(); // Stage 1 only, at this point
  });

  it('detects a pin after the move that creates one', () => {
    const instances = detectMotifsForPly(
      ply({
        movePlayedUci: 'e2e1',
        fenAfter: '4k3/8/8/4n3/8/8/8/4R2K b - - 0 1'
      }),
      320
    );
    const pin = instances.find((m) => m.motif === 'pin');
    expect(pin).toBeDefined();
    expect(pin!.squares).toEqual({ attacker: 'e1', targets: ['e8'], throughSquare: 'e5' });
  });

  it('detects a discovered attack revealed by the move', () => {
    const instances = detectMotifsForPly(
      ply({
        movePlayedUci: 'e3d4', // bishop steps off e3, uncovering Re1 -> Ke8
        fenAfter: '4k3/8/8/8/8/8/8/4R2K b - - 0 1'
      }),
      320
    );
    const discovery = instances.find((m) => m.motif === 'discovery');
    expect(discovery).toBeDefined();
    expect(discovery!.squares).toEqual({ attacker: 'e1', targets: ['e8'], throughSquare: 'e3' });
  });

  it('produces deterministic, distinct ids across repeated calls on the same ply', () => {
    const a = detectMotifsForPly(ply({}), 320);
    const b = detectMotifsForPly(ply({}), 320);
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    expect(new Set(a.map((m) => m.id)).size).toBe(a.length);
  });
});

describe('confirmMotifSignificance', () => {
  it('attaches significanceEvidence only when the triggering ply gained for the mover', () => {
    const [fork] = detectMotifsForPly(ply({}), 320);
    const confirmed = confirmMotifSignificance(fork!, 300);
    expect(confirmed.significanceEvidence?.basis).toBe('engine-eval');

    const unconfirmed = confirmMotifSignificance(fork!, -50);
    expect(unconfirmed.significanceEvidence).toBeUndefined();
  });
});

describe('detectMotifs', () => {
  it('runs Stage 1 + Stage 2 over a full ply list deterministically', () => {
    const plies = [ply({ ply: 1, swingForMoverCp: 300 })];
    const a = detectMotifs(plies, 320);
    const b = detectMotifs(plies, 320);
    expect(a).toEqual(b);
    expect(a.some((m) => m.motif === 'fork' && m.significanceEvidence !== undefined)).toBe(true);
  });
});
