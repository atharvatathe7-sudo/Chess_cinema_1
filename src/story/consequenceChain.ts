import type { Color } from '../chess/ChessEngine';
import type { Evaluation, GameAnalysis, PlyAnalysis } from '../analysis/types';
import { toComparableCp } from '../analysis/evaluation';
import type { GameUnderstanding } from '../understanding/types';
import { boardFromFen, materialBalance } from '../understanding/geometry';
import { detectDefenderLoss } from '../understanding/defenders';
import type { GameOutcome } from './gameOutcome';
import type { CausalFact, CausalLink, ConsequenceChain, PayoffTerminus } from './types';
import { buildCausalChain } from './causalGraph';

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

// ============================================================
// Phase 16 — chess-fact classification (MUST HAVE 5)
// ============================================================

/**
 * Every fact below is a direct measurement over evidence that already exists.
 * None of them is a causal claim: they say what happened at a ply, never that
 * it is why the game ended. Naming that stronger relationship stays gated by
 * StoryConfidence.causalClaimAllowed, which is computed elsewhere and consumed
 * by the caption layer.
 */

/** Material swing worth naming, on geometry.ts's PIECE_VALUE scale — the same floor a settled payoff uses. */
const MATERIAL_LOST_FLOOR = MATERIAL_SETTLED_FLOOR;
/**
 * Mover-relative evaluation drop that counts as a collapse: roughly three
 * pawns, matching understanding/causeConsequence.ts's own COLLAPSE_CP scale
 * for the point at which a "defensive success" reading stops being honest.
 */
const EVAL_COLLAPSE_CP = 300;
/**
 * How long a collapse must still be standing to be a collapse rather than a
 * spike, and how much of it must remain.
 *
 * Deliberately NOT storyCandidates.ts's evalPersistencePlies: that measures
 * whether the advantage a TRIGGER created survived, anchored to the position
 * before the trigger. This asks a different question about a different ply —
 * did the drop measured AT this ply endure — so it is its own measurement
 * rather than a reuse that would quietly mean something else.
 */
const COLLAPSE_PERSISTENCE_PLIES = 6;
const COLLAPSE_RETENTION = 0.5;

/** Fixed serialization order, so a link's facts are deterministic regardless of test order. */
const CAUSAL_FACT_ORDER: readonly CausalFact[] = [
  'defender-lost',
  'material-lost',
  'evaluation-collapse',
  'forced-response',
  'escape-square-removed'
];

function comparableOrNull(evaluation: Evaluation): number | null {
  return evaluation.kind === 'terminal' ? null : toComparableCp(evaluation);
}

function safeMaterial(fen: string): number | null {
  try {
    return materialBalance(boardFromFen(fen));
  } catch {
    return null;
  }
}

/** material-lost — the ply's own board diff, not "a capture happened". */
function hasMaterialLoss(ply: PlyAnalysis): boolean {
  const before = safeMaterial(ply.fenBefore);
  const after = safeMaterial(ply.fenAfter);
  if (before === null || after === null) return false;
  return Math.abs(after - before) >= MATERIAL_LOST_FLOOR;
}

/**
 * evaluation-collapse — a decisive drop against the mover that is STILL there
 * later. A single Stockfish spike that reverts on the next ply is explicitly
 * not a collapse, which is the whole point of the persistence half.
 */
function hasEvaluationCollapse(ply: PlyAnalysis, pliesByNumber: ReadonlyMap<number, PlyAnalysis>, lastPly: number): boolean {
  const before = comparableOrNull(ply.evaluationBefore);
  const after = comparableOrNull(ply.evaluationAfter);
  if (before === null || after === null) return false;

  // Mover-relative: a drop is a drop for whoever just moved.
  const droppedForMover = ply.sideToMove === 'w' ? after - before : -(after - before);
  if (droppedForMover > -EVAL_COLLAPSE_CP) return false;

  const horizon = Math.min(lastPly, ply.ply + COLLAPSE_PERSISTENCE_PLIES);
  for (let p = ply.ply + 1; p <= horizon; p++) {
    const later = pliesByNumber.get(p);
    if (!later) continue;
    const current = comparableOrNull(later.evaluationAfter);
    // A terminal position is the collapse being cashed in, not undone.
    if (current === null) continue;
    const stillDown = ply.sideToMove === 'w' ? current - before : -(current - before);
    if (stillDown > droppedForMover * COLLAPSE_RETENTION) return false;
  }
  return true;
}

/** forced-response — this ply is a reply inside a ForcedSequence, never its opening move. */
function isForcedResponse(ply: number, understanding: GameUnderstanding): boolean {
  return understanding.sequences.some((seq) => seq.plies.includes(ply) && seq.startPly !== ply);
}

/**
 * escape-square-removed — consumes KingMobilityRecord, which understandGame
 * has always computed and nothing has ever read.
 *
 * A record at ply P describes the mobility of the side moving at P, measured
 * before its own move. So the king belonging to the side NOT moving at P is
 * described by the records at P-1 and P+1: comparing those two brackets
 * exactly the effect of the move played at P, with no evaluation input and no
 * generic mobility claim.
 */
function removesEscapeSquares(ply: number, understanding: GameUnderstanding): boolean {
  const at = (p: number) => understanding.kingMobility.find((k) => k.ply === p);
  const before = at(ply - 1);
  const after = at(ply + 1);
  if (!before || !after) return false;
  if (before.color !== after.color) return false;
  return after.legalEscapeSquareCount < before.legalEscapeSquareCount;
}

/**
 * The chess facts observable at one ply. Returns undefined rather than an
 * empty array so "nothing cleared its gate" is distinguishable from "not
 * classified" downstream.
 */
export function classifyCausalFacts(
  plyNumber: number,
  understanding: GameUnderstanding,
  pliesByNumber: ReadonlyMap<number, PlyAnalysis>,
  lastPly: number
): readonly CausalFact[] | undefined {
  const ply = pliesByNumber.get(plyNumber);
  if (!ply) return undefined;

  const found = new Set<CausalFact>();
  if (detectDefenderLoss(ply).length > 0) found.add('defender-lost');
  if (hasMaterialLoss(ply)) found.add('material-lost');
  if (hasEvaluationCollapse(ply, pliesByNumber, lastPly)) found.add('evaluation-collapse');
  if (isForcedResponse(plyNumber, understanding)) found.add('forced-response');
  if (removesEscapeSquares(plyNumber, understanding)) found.add('escape-square-removed');

  if (found.size === 0) return undefined;
  return CAUSAL_FACT_ORDER.filter((fact) => found.has(fact));
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

  // Phase 16 — chess-fact classification, applied AFTER chain membership is
  // fixed. This is deliberately the last step: facts describe plies the chain
  // already contains on structural evidence, and must never be able to pull a
  // new ply into the chain (which would change beats, and with them the whole
  // story). Membership stays evidence-driven; facts stay descriptive.
  const withFacts = (link: CausalLink): CausalLink => {
    const facts = classifyCausalFacts(link.ply, understanding, pliesByNumber, lastPly);
    return facts === undefined ? link : { ...link, causalFacts: facts };
  };
  const triggerFacts = classifyCausalFacts(triggerPly, understanding, pliesByNumber, lastPly);

  return {
    triggerPly,
    ...(triggerFacts !== undefined ? { triggerFacts } : {}),
    antecedents: antecedents.map(withFacts),
    consequents: consequents.map(withFacts),
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
