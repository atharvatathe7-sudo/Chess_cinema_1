import type { PayoffTerminus, StoryPlan } from '../story/types';
import type { ClipWindow, DirectorSettings } from './types';

/**
 * Phase 18A — Cinematic Clip Windowing.
 *
 * Pure derivation of WHICH PART of an already-selected story must be shown,
 * from StoryPlan's own CentralConflict/ConsequenceChain/PayoffTerminus
 * evidence alone. This module makes no story-selection decision (that is
 * buildStoryPlan.ts's job, untouched) and no pacing/camera decision (that
 * remains lowerToTimeline.ts's job) — see this module's own name and the
 * Phase 18A specification's three-layer separation:
 *
 *   Story Engine: What story matters?
 *   Clip Window:  Which part of that story must be shown?
 *   Timeline:     How should those included moves be paced?
 *
 * ConsequenceChain.triggerPly is structurally guaranteed (consequenceChain.ts)
 * to equal the primary turning point's own ply, so this module never
 * re-derives or looks up primaryTurningPointId itself — chain.triggerPly IS
 * that ply, already resolved.
 */

/**
 * checkmate/stalemate/material-settled/eval-settled all carry the payoff's
 * own evidenced ply directly. off-board-result and unresolved carry none —
 * for both, the window's end must come from the chain's own last evidenced
 * consequent (or the critical ply itself, absent any consequents), never
 * from wherever the PGN happens to continue to.
 */
function payoffPlyOf(payoff: PayoffTerminus): number | null {
  switch (payoff.kind) {
    case 'checkmate':
    case 'stalemate':
    case 'material-settled':
    case 'eval-settled':
      return payoff.atPly;
    case 'off-board-result':
    case 'unresolved':
      return null;
  }
}

/**
 * Derives which portion of the game's moves a Cinematic Moment export
 * should include. Abstains (no window) exactly when StoryPlan itself has no
 * central conflict — the existing Full Game fallback is left completely
 * untouched for that case (see lowerToTimeline.ts).
 */
export function deriveClipWindow(story: StoryPlan, settings: DirectorSettings): ClipWindow {
  const conflict = story.centralConflict;
  if (!conflict) {
    return { kind: 'abstained', reason: story.noConflictReason };
  }

  const chain = conflict.consequenceChain;
  const criticalPly = chain.triggerPly;
  const rawSetupPlies = chain.antecedents.map((link) => link.ply);
  const consequencePlies = chain.consequents.map((link) => link.ply);
  const payoffPly = payoffPlyOf(chain.payoff);

  // off-board-result and unresolved both fall back to the chain's own last
  // evidenced consequent (or the critical ply itself) — never the game's
  // final move just because the PGN continues past it.
  const endPly = payoffPly ?? (consequencePlies[consequencePlies.length - 1] ?? criticalPly);
  const rawStartPly = rawSetupPlies[0] ?? criticalPly;

  let startPly = rawStartPly;
  let truncated = false;
  const span = endPly - rawStartPly + 1;
  if (span > settings.maxClipSpanPlies) {
    // Trim SETUP first, never mid-consequence: the latest a trimmed start
    // may land is criticalPly itself — the critical ply and everything
    // after it (consequence + payoff) is never cut by this ceiling.
    const earliestAffordableStart = endPly - settings.maxClipSpanPlies + 1;
    const trimmedStart = Math.min(criticalPly, Math.max(rawStartPly, earliestAffordableStart));
    if (trimmedStart > rawStartPly) {
      startPly = trimmedStart;
      truncated = true;
    }
  }

  const setupPlies = rawSetupPlies.filter((ply) => ply >= startPly);

  return {
    kind: 'windowed',
    startPly,
    setupPlies,
    criticalPly,
    consequencePlies,
    payoffPly,
    endPly,
    truncated
  };
}
