import type { PlyAnalysis } from '../analysis/types';
import { DEFAULT_CANDIDATE_SETTINGS } from '../analysis/candidates';
import type { PlySignals, SignificanceReason, SignificanceRecord, TacticalMotifInstance } from './types';

/**
 * Axis 2 — chess significance. Deliberately symmetric (large swings in
 * EITHER direction count, unlike Phase 2.1's loss-only candidate list) and
 * computed independently of MoveQualityClass — see the MOVE-QUALITY SCOPE
 * note in types.ts. Everything here is deterministic, built only from
 * engine/rule facts already available; 'only-move-under-pressure' is added
 * afterward by the orchestrator once BestAlternativeRecord/MultiPV data
 * exists (see causeConsequence.ts), since that is the one reason not
 * derivable from zero-cost data alone.
 */

const REASON_WEIGHT: Readonly<Record<SignificanceReason, number>> = {
  'large-swing-either-direction': 100,
  'decisive-mate-transition': 400,
  'only-move-under-pressure': 200,
  'confirmed-tactical-motif': 150,
  'forced-sequence-terminal': 100,
  'material-decisive': 250
};

function scoreFor(reasons: readonly SignificanceReason[], swingCp: number): number {
  const base = Math.abs(swingCp);
  const bonus = reasons.reduce((sum, r) => sum + REASON_WEIGHT[r], 0);
  return base + bonus;
}

export interface SignificanceContext {
  readonly signals: PlySignals;
  readonly motifs: readonly TacticalMotifInstance[];
  readonly isSequenceTerminal: boolean;
  /** Material balance delta (White-relative, PIECE_VALUE units) attributable to this ply, from before/after board diff. */
  readonly materialDelta: number;
}

const MATERIAL_DECISIVE_FLOOR = 300; // roughly a minor piece — an irrecoverable-feeling material swing

export function computeSignificance(ply: PlyAnalysis, context: SignificanceContext): SignificanceRecord {
  const reasons: SignificanceReason[] = [];

  if (Math.abs(ply.swingCp) >= DEFAULT_CANDIDATE_SETTINGS.minSwingCp) {
    reasons.push('large-swing-either-direction');
  }
  if (ply.mateTransition === 'mate-appeared' || ply.mateTransition === 'mate-flipped' || ply.mateTransition === 'mate-disappeared') {
    reasons.push('decisive-mate-transition');
  }
  if (context.signals.motifIds.some((id) => context.motifs.find((m) => m.id === id)?.significanceEvidence !== undefined)) {
    reasons.push('confirmed-tactical-motif');
  }
  if (context.isSequenceTerminal) {
    reasons.push('forced-sequence-terminal');
  }
  if (Math.abs(context.materialDelta) >= MATERIAL_DECISIVE_FLOOR) {
    reasons.push('material-decisive');
  }

  return { score: scoreFor(reasons, ply.swingCp), reasons };
}

/** Adds a reason discovered later (only-move-under-pressure, from MultiPV data) without recomputing the rest. */
export function withAdditionalReason(
  record: SignificanceRecord,
  reason: SignificanceReason,
  swingCp: number
): SignificanceRecord {
  if (record.reasons.includes(reason)) return record;
  const reasons = [...record.reasons, reason];
  return { score: scoreFor(reasons, swingCp), reasons };
}
