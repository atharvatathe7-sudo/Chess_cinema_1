import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, GameArcSummary, NarrativeArchetypeSignal, TurningPoint } from './types';
import { boardFromFen, materialBalance, totalMaterial } from './geometry';

/**
 * Structural game arc: deterministic, chess-rule evidence only. No move
 * duration, no camera bounding box, no narrative selection — see the
 * reference-material disposition notes carried over from the design
 * specification for why those stay out of this layer.
 */

const OPENING_PLY_CEILING = 24; // ~12 full moves, a defensible fixed fallback
const ENDGAME_MATERIAL_FLOOR = 2600; // total non-king material (both sides) below this reads as an endgame

export function computeGameArc(plies: readonly PlyAnalysis[]): GameArcSummary {
  const materialTrajectory = plies.map((p) => ({
    ply: p.ply,
    materialDiff: materialBalance(boardFromFen(p.fenAfter))
  }));

  const openingEndPly = Math.min(OPENING_PLY_CEILING, plies.length);

  let middlegameEndPly = plies.length;
  for (const p of plies) {
    if (totalMaterial(boardFromFen(p.fenAfter)) < ENDGAME_MATERIAL_FLOOR) {
      middlegameEndPly = p.ply;
      break;
    }
  }
  middlegameEndPly = Math.max(middlegameEndPly, openingEndPly);

  return {
    openingEndPly,
    middlegameEndPly,
    materialTrajectory,
    evidence: {
      basis: 'chess-rule',
      sourcePlies: plies.map((p) => p.ply),
      note: `opening ceiling ${OPENING_PLY_CEILING} plies; endgame material floor ${ENDGAME_MATERIAL_FLOOR}`
    }
  };
}

/**
 * Narrative archetype signals — always plural, always confidence < 1, built
 * only from concrete evidence already computed elsewhere (ForcedSequence,
 * TurningPoint). This is deliberately a minimal, extensible starting set,
 * not an exhaustive catalogue of the reference material's five archetypes:
 * Phase 2.2's job is to surface reliably-derivable signals, not to pick a
 * genre. See the Phase 2.2 specification's reference-material disposition
 * notes for what was explicitly rejected or deferred.
 */
export function computeNarrativeSignals(
  sequences: readonly ForcedSequence[],
  turningPoints: readonly TurningPoint[]
): NarrativeArchetypeSignal[] {
  const signals: NarrativeArchetypeSignal[] = [];

  const kingHuntSequence = sequences.find(
    (seq) => seq.forcingReason === 'check' && seq.plies.length >= 4 && turningPoints.some((tp) => tp.ply === seq.endPly && (tp.kind === 'forced-mate-delivery' || tp.kind === 'mate-appeared'))
  );
  if (kingHuntSequence) {
    signals.push({
      archetype: 'king-hunt',
      supportingEvidence: [
        kingHuntSequence.evidence,
        { basis: 'inference', confidence: 0.55, sourcePlies: kingHuntSequence.plies, note: 'a forced check sequence of 4+ plies ending in mate' }
      ],
      confidence: 0.55
    });
  }

  return signals;
}
