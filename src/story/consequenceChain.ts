import type { Color } from '../chess/ChessEngine';
import type { Evaluation, GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import type { GameOutcome } from './gameOutcome';
import type { CausalLink, ConsequenceChain, PayoffTerminus } from './types';
import { buildCausalChain } from './centralConflict';

/**
 * Phase 15 — directional consequence chains.
 *
 * The old model produced a flat CausalLink[] with no notion of direction and
 * no notion of arrival. beats.ts recovered direction by comparing ply
 * numbers to the climax, and nothing could express "and then the game
 * ended" — so a mate three plies after the climax was structurally invisible
 * to the story and arrived as an unrelated terminal annotation.
 *
 * This module walks FORWARD from a trigger using evidence only, never ply
 * proximity, via three extension rules layered on the existing
 * buildCausalChain links:
 *
 *   forced-sequence continuation  the trigger's own ForcedSequence (already
 *                                 modelled; carried through unchanged)
 *   mate-transition continuity    while a forced mate stands for the same
 *                                 side, each following ply is part of the
 *                                 same story — this is what carries a climax
 *                                 through to the mate that delivers it
 *   terminal arrival              a chain that has reached the ply before a
 *                                 genuinely terminal position includes it;
 *                                 the checkmate/stalemate IS the payoff
 *
 * Off-board endings are NOT an extension rule. A resignation does not
 * causally follow from a move the way a forced mate does, so a chain reaches
 * an off-board result only if the above rules already carried it to the last
 * ply. Otherwise every candidate in every resigned game would trivially
 * "reach the result" and Gate 2's tiering would mean nothing.
 */

/** Consequence magnitudes at which a settled payoff is worth naming. */
const MATERIAL_SETTLED_FLOOR = 200;
const EVAL_SETTLED_FLOOR = 150;

function mateSide(evaluation: Evaluation): Color | null {
  if (evaluation.kind !== 'mate') return null;
  return evaluation.mateIn > 0 ? 'w' : 'b';
}

/**
 * Mate-transition continuity. From `fromPly`, walks forward for as long as a
 * forced mate remains on the board for the SAME side, and includes the
 * terminal position that mate arrives at. Stops the moment the mate
 * disappears or changes hands — a mate that evaporates did not lead to
 * anything, which is exactly the distinction this walk exists to make.
 */
function mateContinuityPlies(fromPly: number, pliesByNumber: ReadonlyMap<number, PlyAnalysis>, lastPly: number): number[] {
  const start = pliesByNumber.get(fromPly);
  if (!start) return [];
  const side = mateSide(start.evaluationAfter);
  if (side === null) return [];

  const reached: number[] = [];
  for (let p = fromPly + 1; p <= lastPly; p++) {
    const ply = pliesByNumber.get(p);
    if (!ply) break;
    const evaluation = ply.evaluationAfter;
    if (evaluation.kind === 'terminal') {
      // The mate landed (or the position resolved) — include it and stop.
      reached.push(p);
      break;
    }
    if (mateSide(evaluation) !== side) break;
    reached.push(p);
  }
  return reached;
}

/** Terminal arrival: a chain sitting one ply short of a terminal position includes it. */
function terminalArrivalPly(chainEndPly: number, pliesByNumber: ReadonlyMap<number, PlyAnalysis>, lastPly: number): number | null {
  if (chainEndPly >= lastPly) return null;
  const last = pliesByNumber.get(lastPly);
  if (!last || last.evaluationAfter.kind !== 'terminal') return null;
  return chainEndPly === lastPly - 1 ? lastPly : null;
}

function payoffFor(
  chainEndPly: number,
  reachedLastPly: boolean,
  outcome: GameOutcome,
  triggerTp: { materialNet: number; evalSwing: number; consequenceAtPly: number }
): PayoffTerminus {
  if (reachedLastPly) {
    const evaluation = outcome.finalEvaluation;
    if (evaluation.kind === 'terminal') {
      if (evaluation.result === 'draw') {
        return evaluation.drawReason === 'stalemate'
          ? { kind: 'stalemate', atPly: chainEndPly }
          : { kind: 'off-board-result', result: outcome.result ?? '*', termination: outcome.termination };
      }
      return { kind: 'checkmate', atPly: chainEndPly };
    }
    // The chain arrived at the last played ply but the board is not
    // terminal: the game was decided off the board. Both facts are kept.
    //
    // Only when we actually KNOW how it was decided. An 'off-board-result'
    // payoff asserts "the game ended this way", and a PGN that records a
    // result with no terminal position and no termination reason does not
    // support that claim — a truncated import looks identical. Falling
    // through leaves the candidate to be judged on what it actually did,
    // which is what makes an unsupported game abstain rather than acquire a
    // Tier-A story by running out of plies.
    if (outcome.termination !== 'absent' && outcome.termination !== 'unknown') {
      return { kind: 'off-board-result', result: outcome.result ?? '*', termination: outcome.termination };
    }
  }

  if (Math.abs(triggerTp.materialNet) >= MATERIAL_SETTLED_FLOOR) {
    return { kind: 'material-settled', atPly: triggerTp.consequenceAtPly, netMaterialChange: triggerTp.materialNet };
  }
  if (Math.abs(triggerTp.evalSwing) >= EVAL_SETTLED_FLOOR) {
    return { kind: 'eval-settled', atPly: triggerTp.consequenceAtPly, finalSwingCp: triggerTp.evalSwing };
  }
  return { kind: 'unresolved' };
}

/**
 * Builds the directional chain for one trigger ply. Pure; every input is
 * already materialized.
 */
export function buildConsequenceChain(
  triggerPly: number,
  understanding: GameUnderstanding,
  analysis: GameAnalysis,
  outcome: GameOutcome
): ConsequenceChain {
  const pliesByNumber = new Map(analysis.plies.map((p) => [p.ply, p]));
  const lastPly = analysis.plies[analysis.plies.length - 1]?.ply ?? triggerPly;

  const flat = buildCausalChain(triggerPly, understanding);
  const antecedents = flat.filter((l) => l.ply < triggerPly);
  const consequentsByPly = new Map<number, CausalLink>();
  for (const link of flat) {
    if (link.ply > triggerPly) consequentsByPly.set(link.ply, link);
  }

  const turningPoint = understanding.turningPoints.find((tp) => tp.ply === triggerPly);
  const cc = turningPoint?.causeConsequence;

  // Extension 1 — mate-transition continuity from the trigger itself, and
  // again from whatever ply the existing links already reach.
  const reachedSoFar = () => Math.max(triggerPly, ...[...consequentsByPly.keys()], triggerPly);
  for (const ply of mateContinuityPlies(triggerPly, pliesByNumber, lastPly)) {
    if (!consequentsByPly.has(ply)) consequentsByPly.set(ply, { ply, linkType: 'mate-transition-continuity', evidenceId: `mate-${triggerPly}` });
  }
  for (const ply of mateContinuityPlies(reachedSoFar(), pliesByNumber, lastPly)) {
    if (!consequentsByPly.has(ply)) consequentsByPly.set(ply, { ply, linkType: 'mate-transition-continuity', evidenceId: `mate-${reachedSoFar()}` });
  }

  // Extension 2 — terminal arrival, applied after every other extension so
  // it can close a chain that the others carried to the penultimate ply.
  const arrival = terminalArrivalPly(reachedSoFar(), pliesByNumber, lastPly);
  if (arrival !== null) {
    consequentsByPly.set(arrival, { ply: arrival, linkType: 'terminal-arrival', evidenceId: `terminal-${arrival}` });
  }

  const consequents = [...consequentsByPly.values()].sort((a, b) => a.ply - b.ply);
  const chainEndPly = consequents.length > 0 ? consequents[consequents.length - 1]!.ply : triggerPly;
  const arrivedAtLastPly = chainEndPly >= lastPly;

  const payoff = payoffFor(chainEndPly, arrivedAtLastPly, outcome, {
    materialNet: cc?.materialConsequence.netMaterialChange ?? 0,
    evalSwing: cc?.evaluationConsequence.swingCp ?? 0,
    consequenceAtPly: cc?.evaluationConsequence.atPly ?? triggerPly
  });

  return {
    triggerPly,
    antecedents,
    consequents,
    payoff,
    // Running out of plies is not the same as explaining the result. A chain
    // "reaches the result" only when it arrived at an ending we can actually
    // name — otherwise there is no result for it to have explained.
    reachesResult: arrivedAtLastPly && payoff.kind !== 'material-settled' && payoff.kind !== 'eval-settled' && payoff.kind !== 'unresolved',
    evidence: {
      basis: 'chess-rule',
      sourcePlies: [triggerPly, ...consequents.map((l) => l.ply)],
      note: `chain ${triggerPly}->${chainEndPly}, payoff ${payoff.kind}, arrivedAtLastPly=${arrivedAtLastPly}`
    }
  };
}
