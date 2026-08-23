import type { GameUnderstanding } from '../understanding/types';
import type { BeatRole, CentralConflict, StoryBeat } from './types';

/**
 * Plies belonging to the spine proper (climax/consequence/resolution) — the
 * central-conflict plies themselves, as opposed to the causally-antecedent
 * setup/building-sequence plies. Exported so retention.ts and
 * pieceContribution.ts share exactly one definition of "spine".
 */
export function spinePliesFromBeats(beats: readonly StoryBeat[]): ReadonlySet<number> {
  const plies = new Set<number>();
  for (const beat of beats) {
    if (beat.role === 'climax' || beat.role === 'consequence' || beat.role === 'resolution') {
      for (const p of beat.plies) plies.add(p);
    }
  }
  return plies;
}

/** Plies belonging to setup/building-sequence — causally antecedent to the spine, not part of it. */
export function setupPliesFromBeats(beats: readonly StoryBeat[]): ReadonlySet<number> {
  const plies = new Set<number>();
  for (const beat of beats) {
    if (beat.role === 'setup' || beat.role === 'building-sequence') {
      for (const p of beat.plies) plies.add(p);
    }
  }
  return plies;
}

function beatId(role: BeatRole, plies: readonly number[]): string {
  return `beat-${role}-${plies[0]}`;
}

/**
 * Builds StoryBeats from the resolved central conflict only — never from
 * archetype signals independently (see archetypes.ts: an archetype signal
 * whose plies don't overlap any beat here simply has an empty beatIds,
 * rather than forcing a second, conflicting beat-generation path).
 */
export function buildBeats(centralConflict: CentralConflict | null, understanding: GameUnderstanding): readonly StoryBeat[] {
  if (!centralConflict) return [];

  const winnerTp = understanding.turningPoints.find((tp) => tp.id === centralConflict.primaryTurningPointId);
  if (!winnerTp) return [];
  const cc = winnerTp.causeConsequence;
  const winnerPly = winnerTp.ply;
  const salience = winnerTp.significance.score;

  const before = centralConflict.causalChain.filter((l) => l.ply < winnerPly);
  const setupLinks = before.filter((l) => l.linkType === 'threat-refutation');
  const buildingLinks = before.filter((l) => l.linkType !== 'threat-refutation');

  const setupPlies = setupLinks.map((l) => l.ply).sort((a, b) => a - b);
  const buildingSequencePlies = buildingLinks.map((l) => l.ply).sort((a, b) => a - b);

  const lastPly = understanding.plies[understanding.plies.length - 1]!.ply;
  const rawEndPly = Math.max(
    cc.evaluationConsequence.atPly,
    cc.materialConsequence.atPly,
    cc.multiMoveConsequence?.endPly ?? winnerPly,
    winnerPly
  );
  const consequenceEndPly = Math.min(rawEndPly, lastPly);

  const fullConsequenceRange: number[] = [];
  for (let p = winnerPly + 1; p <= consequenceEndPly; p++) fullConsequenceRange.push(p);

  const touchesGameEnd = consequenceEndPly === lastPly && consequenceEndPly > winnerPly;
  const climaxIsGameEnd = winnerPly === lastPly;

  let consequencePlies = fullConsequenceRange;
  let resolutionPlies: number[] = [];
  if (touchesGameEnd) {
    resolutionPlies = [fullConsequenceRange[fullConsequenceRange.length - 1]!];
    consequencePlies = fullConsequenceRange.slice(0, -1);
  } else if (climaxIsGameEnd) {
    // The climax move itself ends the game (e.g. a forced-mate-delivery) — the
    // same ply is simultaneously the climax and the resolution beat.
    resolutionPlies = [winnerPly];
  }

  const beats: StoryBeat[] = [];

  if (setupPlies.length > 0) {
    const threatIds = [...new Set(setupLinks.map((l) => l.evidenceId))].sort();
    beats.push({ id: beatId('setup', setupPlies), role: 'setup', plies: setupPlies, evidenceRefs: { threatIds }, salience });
  }

  if (buildingSequencePlies.length > 0) {
    // Deterministic single sequenceId: the earliest-established link's evidenceId.
    const earliest = buildingLinks.reduce((min, l) => (l.ply < min.ply ? l : min), buildingLinks[0]!);
    beats.push({
      id: beatId('building-sequence', buildingSequencePlies),
      role: 'building-sequence',
      plies: buildingSequencePlies,
      evidenceRefs: { sequenceId: earliest.evidenceId },
      salience
    });
  }

  beats.push({
    id: beatId('climax', [winnerPly]),
    role: 'climax',
    plies: [winnerPly],
    evidenceRefs: { turningPointId: winnerTp.id, causeConsequenceId: cc.id },
    salience
  });

  if (consequencePlies.length > 0) {
    beats.push({
      id: beatId('consequence', consequencePlies),
      role: 'consequence',
      plies: consequencePlies,
      evidenceRefs: {
        causeConsequenceId: cc.id,
        ...(cc.multiMoveConsequence ? { sequenceId: cc.multiMoveConsequence.sequenceId } : {})
      },
      salience
    });
  }

  if (resolutionPlies.length > 0) {
    beats.push({
      id: beatId('resolution', resolutionPlies),
      role: 'resolution',
      plies: resolutionPlies,
      evidenceRefs: { causeConsequenceId: cc.id },
      salience
    });
  }

  return beats;
}
