import type { GameAnalysis } from '../analysis/types';
import type { GameUnderstanding, TurningPoint } from '../understanding/types';
import type { GameOutcome } from './gameOutcome';
import { selectStoryCandidate } from './storyCandidates';
import type { CausalLink, CentralConflict, NoConflictReason, StorySettings } from './types';

/**
 * Deterministic EDITORIAL ranking — not objective chess truth. A different,
 * equally defensible rule (earliest decisive turning point, or raw
 * |swingCp| instead of composite significance.score) would select a
 * different spine from the same game. This is the one rule Phase 2.3 uses,
 * fixed by explicit product decision:
 *   1. significance.score descending
 *   2. |materialConsequence.netMaterialChange| descending
 *   3. ply ascending
 */
function rankTurningPoints(turningPoints: readonly TurningPoint[]): readonly TurningPoint[] {
  return [...turningPoints].sort((a, b) => {
    if (b.significance.score !== a.significance.score) return b.significance.score - a.significance.score;
    const aMat = Math.abs(a.causeConsequence.materialConsequence.netMaterialChange);
    const bMat = Math.abs(b.causeConsequence.materialConsequence.netMaterialChange);
    if (bMat !== aMat) return bMat - aMat;
    return a.ply - b.ply;
  });
}

/**
 * Grows the causal chain outward from `primaryPly` using exactly the three
 * link types the data model supports — same-sequence membership,
 * multiMoveConsequence, and ThreatRecord.refutedBy. Never ply proximity.
 * Breadth-first with a visited-ply guard; the underlying structures
 * (ForcedSequence, multiMoveConsequence, refutedBy) are all finite per ply,
 * so this always terminates — the guard is a safety net, not a response to
 * a known cycle. Returns links ascending by ply, excluding primaryPly
 * itself (resolve that via primaryTurningPointId).
 */
export function buildCausalChain(primaryPly: number, understanding: GameUnderstanding): readonly CausalLink[] {
  const links: CausalLink[] = [];
  const visited = new Set<number>([primaryPly]);
  const queue: number[] = [primaryPly];

  while (queue.length > 0) {
    const ply = queue.shift()!;

    for (const seq of understanding.sequences) {
      if (!seq.plies.includes(ply)) continue;
      for (const other of seq.plies) {
        if (visited.has(other)) continue;
        visited.add(other);
        links.push({ ply: other, linkType: 'same-sequence', evidenceId: seq.id });
        queue.push(other);
      }
    }

    const tpHere = understanding.turningPoints.find((t) => t.ply === ply);
    const mmc = tpHere?.causeConsequence.multiMoveConsequence;
    if (mmc) {
      const seq = understanding.sequences.find((s) => s.id === mmc.sequenceId);
      if (seq) {
        for (const other of seq.plies) {
          if (visited.has(other)) continue;
          visited.add(other);
          links.push({ ply: other, linkType: 'multi-move-consequence', evidenceId: seq.id });
          queue.push(other);
        }
      }
    }

    for (const threat of understanding.threats) {
      if (threat.ply === ply && threat.refutedBy && !visited.has(threat.refutedBy.ply)) {
        visited.add(threat.refutedBy.ply);
        links.push({ ply: threat.refutedBy.ply, linkType: 'threat-refutation', evidenceId: threat.id });
        queue.push(threat.refutedBy.ply);
      }
      if (threat.refutedBy?.ply === ply && !visited.has(threat.ply)) {
        visited.add(threat.ply);
        links.push({ ply: threat.ply, linkType: 'threat-refutation', evidenceId: threat.id });
        queue.push(threat.ply);
      }
    }
  }

  return links.sort((a, b) => a.ply - b.ply);
}

/**
 * Phase 15 — selection is now the five-gate cascade in storyCandidates.ts,
 * not `rankTurningPoints[0]`. rankTurningPoints survives only to order the
 * SECONDARY conflicts, which is a presentation list rather than a claim
 * about what the game was about.
 *
 * GATE 0 (the GameOutcome) is resolved by buildStoryPlan and threaded in,
 * because every later gate consults it.
 */
export function selectCentralConflict(
  understanding: GameUnderstanding,
  analysis: GameAnalysis,
  outcome: GameOutcome,
  settings: StorySettings
): { readonly centralConflict: CentralConflict | null; readonly noConflictReason?: NoConflictReason } {
  const selection = selectStoryCandidate(understanding, analysis, outcome, settings);
  if (selection.kind === 'abstain') {
    return { centralConflict: null, noConflictReason: selection.reason };
  }

  const winner = selection.winner.turningPoint;

  // Retained from the original rule: a hard significance floor still applies
  // and is still configurable. It defaults to 0 (excluding nothing), and now
  // sits AFTER the gates rather than being the whole decision.
  if (winner.significance.score < settings.significanceFloorForConflict) {
    return { centralConflict: null, noConflictReason: 'below-significance-floor' };
  }

  const chain = selection.winner.chain;
  const causalChain = [...chain.antecedents, ...chain.consequents].sort((a, b) => a.ply - b.ply);
  const chainPlies = new Set<number>([winner.ply, ...causalChain.map((l) => l.ply)]);

  const secondaryConflicts = rankTurningPoints(understanding.turningPoints)
    .filter((tp) => tp.id !== winner.id && !chainPlies.has(tp.ply))
    .map((tp) => tp.id)
    .slice(0, settings.maxSecondaryConflicts);

  return {
    centralConflict: {
      primaryTurningPointId: winner.id,
      causalChain,
      secondaryConflicts,
      consequenceChain: chain,
      tier: selection.winner.tier
    },
    noConflictReason: undefined
  };
}
