import type { GameUnderstanding } from '../understanding/types';
import type { CausalLink } from './types';

/**
 * Phase 16 — the generic causal-graph walk, extracted from centralConflict.ts.
 *
 * This module is a LEAF of the story layer: it imports nothing from
 * centralConflict.ts, storyCandidates.ts, or consequenceChain.ts. That is the
 * entire point of its existence.
 *
 * Before this extraction the story layer contained a three-file runtime
 * (value-level, not type-only) import cycle:
 *
 *   consequenceChain.ts -> centralConflict.ts   (buildCausalChain)
 *   centralConflict.ts  -> storyCandidates.ts   (selectStoryCandidate)
 *   storyCandidates.ts  -> consequenceChain.ts  (buildConsequenceChain)
 *
 * It happened to work only because every cross-file call sits inside a
 * function body, so nothing ran during module initialization. Any future
 * top-level constant computed by calling across the cycle would have broken
 * silently, depending on ES module evaluation order. buildCausalChain never
 * had anything to do with central-conflict SELECTION in the first place — it
 * is a generic walk over GameUnderstanding's own evidence — so moving it here
 * breaks the cycle without moving any behaviour.
 */

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
