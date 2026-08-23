import type { GameUnderstanding } from '../understanding/types';
import type { ArchetypeSignal, MoveTreatment, StoryBeat } from './types';
import { setupPliesFromBeats, spinePliesFromBeats } from './beats';

/**
 * Every ply gets exactly one MoveTreatment. 'pruned' is a label on
 * StoryPlan.moveTreatment only — the underlying PlySemantics for that ply
 * remains fully present, untouched, in GameUnderstanding.plies. Nothing is
 * ever discarded here, only classified.
 */
export function classifyMoveTreatment(
  understanding: GameUnderstanding,
  beats: readonly StoryBeat[],
  archetypeSignals: readonly ArchetypeSignal[]
): readonly { readonly ply: number; readonly treatment: MoveTreatment }[] {
  const spinePlies = spinePliesFromBeats(beats);
  const setupPlies = setupPliesFromBeats(beats);

  const archetypePlies = new Set<number>();
  for (const signal of archetypeSignals) for (const p of signal.plies) archetypePlies.add(p);

  const motifPlies = new Set(understanding.motifs.map((m) => m.ply));
  const threatPlies = new Set(understanding.threats.map((t) => t.ply));
  const sequencePlies = new Set(understanding.sequences.flatMap((s) => s.plies));

  return understanding.plies.map((ps) => {
    const ply = ps.ply;
    let treatment: MoveTreatment;

    if (spinePlies.has(ply)) {
      treatment = 'spine';
    } else if (setupPlies.has(ply)) {
      treatment = 'setup';
    } else if (
      ply <= understanding.gameArc.openingEndPly &&
      ps.qualityClass === 'optimal' &&
      !motifPlies.has(ply) &&
      !threatPlies.has(ply) &&
      !sequencePlies.has(ply) &&
      !archetypePlies.has(ply)
    ) {
      treatment = 'theory';
    } else if (
      motifPlies.has(ply) ||
      threatPlies.has(ply) ||
      sequencePlies.has(ply) ||
      ps.qualityClass !== 'optimal' ||
      archetypePlies.has(ply)
    ) {
      treatment = 'compressible';
    } else {
      treatment = 'pruned';
    }

    return { ply, treatment };
  });
}
