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
 *   2. resolution corroborated         (understanding/causeConsequence M3)
 *   3. consequence chain non-empty     nothing followed => nothing was "led to"
 *   4. trigger and payoff causally linked, not merely near each other
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

  const causalClaimAllowed = mechanismVerified && resolutionCorroborated && hasConsequents && triggerLinkedToPayoff;

  const reasons: string[] = [];
  if (!mechanismVerified) reasons.push('mechanism not verified');
  if (!resolutionCorroborated) reasons.push('resolution not corroborated');
  if (!hasConsequents) reasons.push('no consequents');
  if (!triggerLinkedToPayoff) reasons.push('trigger not linked to a payoff');
  if (reachesResult) reasons.push('chain reaches the result');
  if (reasons.length === 0) reasons.push('all causal preconditions met');

  let level: ConfidenceLevel;
  if (causalClaimAllowed && reachesResult) {
    level = 'high';
  } else if (causalClaimAllowed || (resolutionCorroborated && triggerLinkedToPayoff)) {
    level = 'medium';
  } else {
    level = 'low';
  }

  return { level, causalClaimAllowed, mechanismVerified, resolutionCorroborated, hasConsequents, reachesResult, reasons };
}
