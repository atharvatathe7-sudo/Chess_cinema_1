import type { GameUnderstanding } from '../understanding/types';
import type { CentralConflict, ConfidenceLevel, NoConflictReason, StoryConfidence } from './types';

/**
 * Phase 15 — the claim ladder.
 *
 * Two states are kept deliberately distinct rather than collapsed into one
 * number, because they call for different handling:
 *
 *   NO MEANINGFUL CINEMATIC STORY        level 'none'. Structural: nothing
 *                                        survived the gates, or the recorded
 *                                        result is unsupported by anything
 *                                        observable.
 *   STRONG EVENT, INSUFFICIENT CAUSAL    level 'low'. A real event exists;
 *   EVIDENCE                             the evidence for a causal statement
 *                                        about it does not. The story is
 *                                        still told, in weaker wording.
 *
 * `causalClaimAllowed` gates narration of the form "X led to Y" — the
 * strongest thing this system says, and where every fabrication in the
 * benchmark lived. It requires all four preconditions simultaneously:
 *
 *   1. mechanism verified              (understanding/mechanismVerification)
 *   2. consequence corroborated        the trigger-local resolution (M3), OR
 *                                      the chain's own observed terminal payoff
 *   3. consequence chain non-empty     nothing followed => nothing was "led to"
 *   4. trigger and payoff causally linked, not merely near each other
 *
 * Phase 16 corrected precondition 2. It previously consulted ONLY the
 * trigger-local `resolution`, which understanding/causeConsequence.ts measures
 * at the trigger's own consequence ply (`sequence ? endPly : ply`). For any
 * trigger whose payoff lands later — every mate that arrives a few plies after
 * the losing move — that measurement necessarily reads 'unresolved', even
 * while the consequence chain had already walked, on evidence, to the
 * checkmate. Two representations of the same question disagreed, and the
 * weaker one was the only one wired in.
 *
 * The fix is a representation correction, not a loosening: the chain payoff
 * counts only when the chain REACHED it (`reachesResult`) and only for an
 * ending the engine actually observed on the board. Every other precondition
 * — mechanismVerified above all — is unchanged, so a payoff alone can never
 * buy a causal claim.
 *
 * Note that significance.score is deliberately NOT an input. A high score
 * must never buy confidence — that is the original error being corrected.
 */

/**
 * A resolution is corroborated exactly when M3's own preconditions produced
 * it. 'unresolved' asserts nothing and so needs no corroboration, but it
 * also supports no causal claim.
 */
const CORROBORATED_RESOLUTIONS = new Set(['decisive-advantage', 'material-gain', 'forced-mate', 'repelled', 'drawn']);

/**
 * Payoffs that corroborate a consequence at CHAIN level.
 *
 * Deliberately only the two the engine saw on the board. 'off-board-result' is
 * excluded: it rests on the PGN's own [Termination] claim rather than an
 * observed position, and a causal statement should not be underwritten by a
 * file's assertion about how a game ended. The settled/unresolved payoffs
 * cannot appear here at all — `reachesResult` is false for them by
 * construction (see story/consequenceChain.ts).
 */
const CORROBORATING_PAYOFFS = new Set(['checkmate', 'stalemate']);

export function buildConfidence(
  centralConflict: CentralConflict | null,
  understanding: GameUnderstanding,
  noConflictReason: NoConflictReason | undefined
): StoryConfidence {
  if (!centralConflict) {
    return {
      level: 'none',
      causalClaimAllowed: false,
      mechanismVerified: false,
      resolutionCorroborated: false,
      payoffCorroborated: false,
      hasConsequents: false,
      reachesResult: false,
      reasons: [`no-story: ${noConflictReason ?? 'unknown'}`]
    };
  }

  const tp = understanding.turningPoints.find((t) => t.id === centralConflict.primaryTurningPointId);
  const cc = tp?.causeConsequence;
  const chain = centralConflict.consequenceChain;

  const mechanismVerified = cc?.mechanismVerified === true && cc.mechanism !== null;
  const resolutionCorroborated = cc !== undefined && CORROBORATED_RESOLUTIONS.has(cc.resolution);
  const hasConsequents = chain.consequents.length > 0;
  const reachesResult = chain.reachesResult;
  // A payoff of 'unresolved' means the chain never arrived anywhere, so
  // trigger and payoff are not linked however many consequents were walked.
  const triggerLinkedToPayoff = hasConsequents && chain.payoff.kind !== 'unresolved';

  // Phase 16 — either representation of "we know what followed" satisfies
  // precondition 2; the chain-level one is the stronger of the two.
  const payoffCorroborated = reachesResult && CORROBORATING_PAYOFFS.has(chain.payoff.kind);
  const consequenceCorroborated = resolutionCorroborated || payoffCorroborated;

  const causalClaimAllowed = mechanismVerified && consequenceCorroborated && hasConsequents && triggerLinkedToPayoff;

  const reasons: string[] = [];
  if (!mechanismVerified) reasons.push('mechanism not verified');
  if (!consequenceCorroborated) reasons.push('consequence not corroborated');
  else if (!resolutionCorroborated) reasons.push(`consequence corroborated by the chain payoff (${chain.payoff.kind})`);
  if (!hasConsequents) reasons.push('no consequents');
  if (!triggerLinkedToPayoff) reasons.push('trigger not linked to a payoff');
  if (reachesResult) reasons.push('chain reaches the result');
  if (reasons.length === 0) reasons.push('all causal preconditions met');

  let level: ConfidenceLevel;
  if (causalClaimAllowed && reachesResult) {
    level = 'high';
  } else if (causalClaimAllowed || (consequenceCorroborated && triggerLinkedToPayoff)) {
    level = 'medium';
  } else {
    level = 'low';
  }

  return { level, causalClaimAllowed, mechanismVerified, resolutionCorroborated, payoffCorroborated, hasConsequents, reachesResult, reasons };
}
