import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import { toComparableCp } from '../analysis/evaluation';
import type { GameUnderstanding, TurningPoint } from '../understanding/types';
import { isUnsupportedOutcome, winnerOf, type GameOutcome } from './gameOutcome';
import { buildConsequenceChain } from './consequenceChain';
import type { ConsequenceChain, StorySettings, StoryTier } from './types';

/**
 * Phase 15 — story candidate construction and the five-gate cascade.
 *
 * This replaces `sort(turningPoints, by significance.score desc)[0]`, which
 * was the entirety of game-level story selection. That is a category error:
 * significance is a PER-PLY measure, so taking its argmax can only ever
 * return "the most locally striking move" — which is how a routine opening
 * recapture became the story of a 131-ply draw, and how the largest swing in
 * a game became its story despite explaining nothing about how the game
 * ended.
 *
 * Three responsibilities are now separate:
 *
 *   A. Important Event Detection — already exists upstream as
 *      buildTurningPoint. Deliberately generous. Nothing here suppresses a
 *      genuine event at detection time; recall lost there is lost forever.
 *   B. Story Candidate Construction — every event gets its full consequence
 *      chain BEFORE anything is selected, so chain quality can inform
 *      selection. The old code built the chain only for the already-chosen
 *      winner, which meant causal quality could never influence the choice.
 *   C. Game-Level Story Selection — the gate cascade below.
 *
 * The cascade uses HARD GATES, not a weighted sum. A weighted sum
 * reintroduces exactly the failure being fixed: a big enough swing buys its
 * way past every objection. Significance survives only as tie-break #5.
 */

export interface StoryCandidate {
  readonly turningPoint: TurningPoint;
  readonly ply: number;
  readonly chain: ConsequenceChain;
  readonly admissible: boolean;
  readonly tier: StoryTier;
  readonly persistencePlies: number;
  readonly mateStrength: number;
  readonly materialMagnitude: number;
  readonly significanceScore: number;
  /** Short audit strings explaining admissibility/tier — never display copy. */
  readonly notes: readonly string[];
}

// ---- Gate 1 thresholds -------------------------------------------------

const CONSEQUENCE_MATERIAL_FLOOR = 200;
const CONSEQUENCE_EVAL_FLOOR = 150;
const MEANINGFUL_SEQUENCE_LENGTH = 3;
/** How long an advantage must survive to count as real rather than as an oscillation. */
const PERSISTENCE_PLIES_REQUIRED = 6;
/** Below this, no advantage was meaningfully "created" and persistence has nothing to measure. */
const PERSISTENCE_CREATION_FLOOR = 50;
/** Fraction of the created advantage that must remain for it to count as still standing. */
const PERSISTENCE_RETENTION = 0.5;

// ---- Gate 2 thresholds -------------------------------------------------

/** Swing toward the eventual winner that counts as a decisive transition. */
const DECISIVE_TRANSITION_CP = 300;

const MATE_STRENGTH: Readonly<Record<string, number>> = {
  'mate-flipped': 3,
  'mate-appeared': 2,
  'mate-disappeared': 1,
  'mate-sustained': 0,
  none: 0
};

function comparable(ply: PlyAnalysis | undefined, which: 'before' | 'after'): number | null {
  if (!ply) return null;
  const evaluation = which === 'before' ? ply.evaluationBefore : ply.evaluationAfter;
  if (evaluation.kind === 'terminal') return null;
  return toComparableCp(evaluation);
}

/**
 * How many plies the advantage this move created actually survived.
 *
 * Measured against the position BEFORE the trigger, so it answers "is the
 * change this move made still there?" rather than "is the game still
 * roughly like this?". Counts consecutively and stops at the first ply where
 * the advantage has decayed past PERSISTENCE_RETENTION or flipped sign — an
 * advantage that is immediately given back did not persist, however large it
 * was for one ply.
 *
 * Returns Infinity when nothing measurable was created, so the caller can
 * distinguish "did not persist" from "there was nothing to persist" and
 * apply the material test instead.
 */
export function evalPersistencePlies(triggerPly: number, analysis: GameAnalysis): number {
  const byNumber = new Map(analysis.plies.map((p) => [p.ply, p]));
  const before = comparable(byNumber.get(triggerPly), 'before');
  const after = comparable(byNumber.get(triggerPly), 'after');
  if (before === null || after === null) return Infinity;

  const created = after - before;
  if (Math.abs(created) < PERSISTENCE_CREATION_FLOOR) return Infinity;

  const lastPly = analysis.plies[analysis.plies.length - 1]?.ply ?? triggerPly;
  let count = 0;
  for (let p = triggerPly + 1; p <= lastPly; p++) {
    const current = comparable(byNumber.get(p), 'after');
    // A terminal position is the advantage being cashed in, not lost.
    if (current === null) {
      count++;
      continue;
    }
    const remaining = current - before;
    if (Math.sign(remaining) !== Math.sign(created)) break;
    if (Math.abs(remaining) < Math.abs(created) * PERSISTENCE_RETENTION) break;
    count++;
  }
  return count;
}

/** The same question asked of material, for moves whose effect is material rather than evaluative. */
export function materialPersistencePlies(triggerPly: number, understanding: GameUnderstanding): number {
  const trajectory = understanding.gameArc.materialTrajectory;
  const at = (ply: number): number | null => trajectory.find((t) => t.ply === ply)?.materialDiff ?? null;
  const before = at(triggerPly - 1);
  const after = at(triggerPly);
  if (before === null || after === null) return Infinity;

  const created = after - before;
  if (Math.abs(created) < CONSEQUENCE_MATERIAL_FLOOR) return Infinity;

  let count = 0;
  for (const entry of trajectory) {
    if (entry.ply <= triggerPly) continue;
    const remaining = entry.materialDiff - before;
    if (Math.sign(remaining) !== Math.sign(created)) break;
    if (Math.abs(remaining) < Math.abs(created) * PERSISTENCE_RETENTION) break;
    count++;
  }
  return count;
}

function isTerminalEvent(candidateChain: ConsequenceChain, tp: TurningPoint, ply: PlyAnalysis | undefined): boolean {
  if (candidateChain.payoff.kind === 'checkmate' || candidateChain.payoff.kind === 'stalemate') return true;
  if (tp.kind === 'forced-mate-delivery') return true;
  return ply?.mateTransition !== undefined && ply.mateTransition !== 'none';
}

/**
 * GATE 1 — admissibility. Something must actually have followed from this
 * move, and whatever it created must have lasted.
 */
function admit(
  tp: TurningPoint,
  chain: ConsequenceChain,
  understanding: GameUnderstanding,
  analysis: GameAnalysis
): { admissible: boolean; persistencePlies: number; notes: string[] } {
  const notes: string[] = [];
  const cc = tp.causeConsequence;
  const plyAnalysis = analysis.plies.find((p) => p.ply === tp.ply);
  const lastPly = analysis.plies[analysis.plies.length - 1]?.ply ?? tp.ply;
  const sequence = cc.multiMoveConsequence
    ? understanding.sequences.find((s) => s.id === cc.multiMoveConsequence!.sequenceId)
    : undefined;

  // A move that ends the game is meaningful by definition — a checkmate does
  // not have to also clear a centipawn threshold to count as something that
  // happened. Computed first so it can satisfy the consequence test as well
  // as exempt the candidate from the persistence window below.
  const terminal = isTerminalEvent(chain, tp, plyAnalysis);

  const meaningfulConsequence =
    terminal ||
    Math.abs(cc.materialConsequence.netMaterialChange) >= CONSEQUENCE_MATERIAL_FLOOR ||
    Math.abs(cc.evaluationConsequence.swingCp) >= CONSEQUENCE_EVAL_FLOOR ||
    (plyAnalysis?.mateTransition ?? 'none') !== 'none' ||
    (sequence?.plies.length ?? 0) >= MEANINGFUL_SEQUENCE_LENGTH;

  if (!meaningfulConsequence) {
    notes.push('gate1: nothing followed from this move');
    return { admissible: false, persistencePlies: 0, notes };
  }

  const evalPersistence = evalPersistencePlies(tp.ply, analysis);
  const materialPersistence = materialPersistencePlies(tp.ply, understanding);
  // Infinity means "nothing of this kind was created"; the candidate is
  // judged on whichever kind of advantage it actually made.
  const persistencePlies = Math.min(evalPersistence, materialPersistence);
  const nothingToPersist = evalPersistence === Infinity && materialPersistence === Infinity;

  // A terminal event cannot be asked to persist for six plies — the game
  // ends. Likewise a move near the end of the game has fewer plies available
  // than the requirement, so the requirement is capped by what exists. This
  // is a measurement-window limit, not a causal exemption.
  const available = Math.max(0, lastPly - tp.ply);
  const required = Math.min(PERSISTENCE_PLIES_REQUIRED, available);

  if (!terminal) {
    if (nothingToPersist) {
      notes.push('gate1: no measurable advantage was created');
      return { admissible: false, persistencePlies: 0, notes };
    }
    if (persistencePlies < required) {
      notes.push(`gate1: advantage lasted ${persistencePlies} plies, needed ${required}`);
      return { admissible: false, persistencePlies, notes };
    }
  }

  // Move quality, where safely available: an 'optimal' move that is not
  // itself a payoff event did not change the game's course.
  const semantics = understanding.plies.find((p) => p.ply === tp.ply);
  const isPayoffEvent =
    terminal || (semantics?.signals.isPromotion ?? false) || (semantics?.signals.deliversMate ?? false);
  if (semantics && semantics.qualityClass === 'optimal' && !isPayoffEvent) {
    notes.push('gate1: optimal move with no payoff event');
    return { admissible: false, persistencePlies, notes };
  }

  return { admissible: true, persistencePlies, notes };
}

/**
 * GATE 2 — relationship to the actual result.
 *
 * Tier A explains the result, Tier B shapes it, Tier C is locally striking
 * only. A always outranks B; B always outranks C; significance never
 * overcomes the hierarchy. This is the gate that stops "biggest swing" from
 * being the answer to "what happened in this game".
 */
function tierFor(tp: TurningPoint, chain: ConsequenceChain, outcome: GameOutcome, analysis: GameAnalysis): { tier: StoryTier; notes: string[] } {
  const notes: string[] = [];
  const cc = tp.causeConsequence;

  if (chain.reachesResult) {
    notes.push(`gate2: chain reaches the result (${chain.payoff.kind})`);
    return { tier: 'A', notes };
  }

  // Second Tier-A route: the last decisive transition toward whoever
  // actually won, never subsequently reversed. This is what a resignation
  // game needs — nothing forcibly connects the losing move to the moment the
  // player resigned, but that move is still why the game ended that way.
  const winner = winnerOf(outcome);
  if (winner !== null) {
    const plyAnalysis = analysis.plies.find((p) => p.ply === tp.ply);
    const swingTowardWinner = plyAnalysis ? (winner === 'w' ? plyAnalysis.swingCp : -plyAnalysis.swingCp) : 0;
    if (swingTowardWinner >= DECISIVE_TRANSITION_CP) {
      const finalCp = outcome.finalEvaluation.kind === 'cp' ? toComparableCp(outcome.finalEvaluation) : null;
      const finalTowardWinner =
        outcome.finalEvaluation.kind === 'terminal'
          ? Infinity
          : finalCp === null
            ? 0
            : winner === 'w'
              ? finalCp
              : -finalCp;
      if (finalTowardWinner > 0) {
        notes.push('gate2: decisive transition toward the eventual winner, never reversed');
        return { tier: 'A', notes };
      }
      notes.push('gate2: transition toward the winner was later reversed');
    }
  }

  if (
    Math.abs(cc.materialConsequence.netMaterialChange) >= CONSEQUENCE_MATERIAL_FLOOR ||
    chain.payoff.kind === 'material-settled' ||
    chain.payoff.kind === 'eval-settled'
  ) {
    notes.push('gate2: meaningful downstream consequence, but does not explain the ending');
    return { tier: 'B', notes };
  }

  notes.push('gate2: locally striking only');
  return { tier: 'C', notes };
}

/** B — build every candidate, chain and all, before anything is selected. */
export function buildStoryCandidates(
  understanding: GameUnderstanding,
  analysis: GameAnalysis,
  outcome: GameOutcome
): readonly StoryCandidate[] {
  return understanding.turningPoints.map((tp) => {
    const chain = buildConsequenceChain(tp.ply, understanding, analysis, outcome);
    const { admissible, persistencePlies, notes } = admit(tp, chain, understanding, analysis);
    const { tier, notes: tierNotes } = tierFor(tp, chain, outcome, analysis);
    const plyAnalysis = analysis.plies.find((p) => p.ply === tp.ply);
    return {
      turningPoint: tp,
      ply: tp.ply,
      chain,
      admissible,
      // An inadmissible candidate keeps its computed tier for audit, but can
      // never be selected — selection filters on `admissible` first.
      tier,
      persistencePlies,
      mateStrength: MATE_STRENGTH[plyAnalysis?.mateTransition ?? 'none'] ?? 0,
      materialMagnitude: Math.abs(tp.causeConsequence.materialConsequence.netMaterialChange),
      significanceScore: tp.significance.score,
      notes: [...notes, ...tierNotes]
    };
  });
}

const TIER_RANK: Readonly<Record<StoryTier, number>> = { A: 0, B: 1, C: 2 };

/**
 * GATE 3 — lexicographic ordering within a tier. Deliberately NOT an
 * additive score: each criterion is only consulted when every criterion
 * above it ties, so no single axis can dominate. significance.score survives
 * here, demoted to fifth, which is where a per-ply measure belongs when the
 * question is game-level.
 */
export function compareCandidates(a: StoryCandidate, b: StoryCandidate): number {
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (a.chain.reachesResult !== b.chain.reachesResult) return a.chain.reachesResult ? -1 : 1;
  if (a.mateStrength !== b.mateStrength) return b.mateStrength - a.mateStrength;
  if (a.materialMagnitude !== b.materialMagnitude) return b.materialMagnitude - a.materialMagnitude;
  if (a.persistencePlies !== b.persistencePlies) return b.persistencePlies - a.persistencePlies;
  if (a.significanceScore !== b.significanceScore) return b.significanceScore - a.significanceScore;
  return a.ply - b.ply;
}

export type SelectionOutcome =
  | { readonly kind: 'selected'; readonly winner: StoryCandidate; readonly ranked: readonly StoryCandidate[] }
  | { readonly kind: 'abstain'; readonly reason: 'no-turning-points' | 'no-admissible-candidate' | 'unsupported-outcome' };

/**
 * C — the cascade. GATE 0 (the outcome) is resolved by the caller and passed
 * in, because every gate below consults it.
 */
export function selectStoryCandidate(
  understanding: GameUnderstanding,
  analysis: GameAnalysis,
  outcome: GameOutcome,
  _settings: StorySettings
): SelectionOutcome {
  if (understanding.turningPoints.length === 0) {
    return { kind: 'abstain', reason: 'no-turning-points' };
  }

  const candidates = buildStoryCandidates(understanding, analysis, outcome);
  const admissible = candidates.filter((c) => c.admissible);

  // GATE 4 (R2) — a result asserted with nothing observable behind it, and
  // no candidate that shapes or explains anything. Narrating this would mean
  // inventing an ending we cannot see. Checked before "no admissible
  // candidate" so the more specific diagnosis wins.
  const hasSubstantiveCandidate = admissible.some((c) => c.tier === 'A' || c.tier === 'B');
  if (isUnsupportedOutcome(outcome) && !hasSubstantiveCandidate) {
    return { kind: 'abstain', reason: 'unsupported-outcome' };
  }

  if (admissible.length === 0) {
    return { kind: 'abstain', reason: 'no-admissible-candidate' };
  }

  const ranked = [...admissible].sort(compareCandidates);
  return { kind: 'selected', winner: ranked[0]!, ranked };
}
