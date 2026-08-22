import { Chess } from 'chess.js';
import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, ForcingReason } from './types';

/**
 * Forced-sequence detection over the plies the game actually played — pure
 * orchestration over data Phase 2.1 already computed, plus one cheap
 * chess.js query per ply pair (legal move count / check status). No engine
 * call.
 *
 * A reply is "forced" if the mover's own move (a) delivered check, (b) left
 * the opponent with exactly one legal move, or (c) the reply is a capture
 * landing on the exact square the mover's own move landed on (a direct
 * recapture). Consecutive forced links are chained into one ForcedSequence.
 * forcingReason on a multi-link chain names the reason for its first link —
 * a chain can mix reasons link to link; the record captures what started it.
 */
export function forcingReasonForReply(mover: PlyAnalysis, reply: PlyAnalysis): ForcingReason | null {
  const chess = new Chess(mover.fenAfter);
  if (chess.isCheck()) return 'check';
  if (chess.moves().length === 1) return 'only-legal-reply';
  const landedSquare = mover.movePlayedUci.slice(2, 4);
  const replyLandedSquare = reply.movePlayedUci.slice(2, 4);
  if (landedSquare === replyLandedSquare) return 'material-forced-recapture';
  return null;
}

export function detectForcedSequences(plies: readonly PlyAnalysis[]): ForcedSequence[] {
  const sequences: ForcedSequence[] = [];
  let seqCounter = 0;
  let i = 0;

  while (i < plies.length - 1) {
    const mover = plies[i]!;
    const reply = plies[i + 1]!;
    const startReason = forcingReasonForReply(mover, reply);
    if (!startReason) {
      i++;
      continue;
    }

    const chainPlies = [mover.ply, reply.ply];
    let j = i + 1;
    while (j < plies.length - 1) {
      const nextMover = plies[j]!;
      const nextReply = plies[j + 1]!;
      const reason = forcingReasonForReply(nextMover, nextReply);
      if (!reason) break;
      chainPlies.push(nextReply.ply);
      j++;
    }

    sequences.push({
      id: `sequence-${seqCounter++}`,
      startPly: chainPlies[0]!,
      endPly: chainPlies[chainPlies.length - 1]!,
      plies: chainPlies,
      forcingReason: startReason,
      evidence: {
        basis: 'chess-rule',
        sourcePlies: chainPlies,
        note: `forced chain starting with ${startReason}, ${chainPlies.length} plies`
      }
    });
    i = j + 1;
  }

  return sequences;
}
