import type { GameRecord } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import type { ArchetypeSignal, PieceContribution, StoryBeat } from './types';
import { spinePliesFromBeats } from './beats';

interface Accumulator {
  spineEventCount: number;
  motifIds: Set<string>;
  wasPromoted: boolean;
  wasCaptured: boolean;
}

/**
 * Factual aggregation only — no "hero" judgment anywhere. A pieceId is
 * included if it took part in a spine event, or is the subject of any
 * ArchetypeSignal (e.g. a pawn-journey pawn whose promotion wasn't part of
 * the selected central conflict still deserves to be listed, with
 * spineEventCount: 0). No ordered move/square history is duplicated here —
 * a consumer already holds `game` and can derive it directly via
 * game.moves.filter(m => m.pieceId === pieceId).
 */
export function buildPieceContributions(
  game: GameRecord,
  understanding: GameUnderstanding,
  beats: readonly StoryBeat[],
  archetypeSignals: readonly ArchetypeSignal[]
): readonly PieceContribution[] {
  const spinePlies = spinePliesFromBeats(beats);
  const movesByPly = new Map(game.moves.map((m) => [m.ply, m]));
  const relevant = new Map<string, Accumulator>();

  const ensure = (pieceId: string): Accumulator => {
    let entry = relevant.get(pieceId);
    if (!entry) {
      entry = { spineEventCount: 0, motifIds: new Set(), wasPromoted: false, wasCaptured: false };
      relevant.set(pieceId, entry);
    }
    return entry;
  };

  for (const ply of spinePlies) {
    const move = movesByPly.get(ply);
    if (!move) continue;
    ensure(move.pieceId).spineEventCount += 1;
    if (move.capturedPieceId) ensure(move.capturedPieceId).spineEventCount += 1;
  }

  for (const motif of understanding.motifs) {
    if (!spinePlies.has(motif.ply)) continue;
    const move = movesByPly.get(motif.ply);
    if (!move) continue;
    ensure(move.pieceId).motifIds.add(motif.id);
  }

  for (const signal of archetypeSignals) {
    for (const ply of signal.plies) {
      const move = movesByPly.get(ply);
      if (!move) continue;
      ensure(move.pieceId);
    }
  }

  for (const move of game.moves) {
    const entry = relevant.get(move.pieceId);
    if (entry && move.promotion !== undefined) entry.wasPromoted = true;
    if (move.capturedPieceId) {
      const capturedEntry = relevant.get(move.capturedPieceId);
      if (capturedEntry) capturedEntry.wasCaptured = true;
    }
  }

  return [...relevant.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pieceId, v]) => ({
      pieceId,
      spineEventCount: v.spineEventCount,
      motifIds: [...v.motifIds].sort(),
      wasPromoted: v.wasPromoted,
      wasCaptured: v.wasCaptured
    }));
}
