import type { PlyAnalysis } from '../analysis/types';
import type { TacticalMotifInstance } from './types';
import { boardFromFen, findDiscoveries, findForks, findLineMotifs } from './geometry';

/**
 * Tactical motif detection, two stages, never collapsed into one:
 *
 * Stage 1 (this module's *Stage1 functions) — pure board geometry on the
 * position after the move. basis: 'chess-rule', always present, never
 * omitted: a geometric pattern is a geometric pattern regardless of
 * whether it turned out to matter.
 *
 * Stage 2 (confirmMotifSignificance) — attaches significanceEvidence only
 * when the ply's own already-computed swingForMoverCp shows the pattern
 * actually realized value for the mover. No new engine call — reuses data
 * Phase 2.1 already produced. A motif instance without significanceEvidence
 * is still reported (the geometry is real) but is not asserted as decisive.
 */

function nextIdFactory(ply: number): (motif: string) => string {
  let counter = 0;
  return (motif: string) => `motif-${ply}-${motif}-${counter++}`;
}

/**
 * Phase 15 — the geometric identity of a motif pattern, independent of which
 * ply observed it. Targets are sorted so the same pattern reported in a
 * different scan order still compares equal; `throughSquare` uses an
 * explicit '-' placeholder rather than being omitted, so a line motif
 * through a square can never collide with a fork that happens to share the
 * same attacker and target set.
 *
 * Deliberately a plain joined string rather than a hash: it exists to answer
 * exactly one question ("is this pattern new on this ply, or was it already
 * standing?") for mechanism verification, and is never persisted or used as
 * a database key — so legibility in an Evidence.note beats compactness.
 */
export function motifInstanceKeyFor(
  motif: TacticalMotifInstance['motif'],
  attacker: string,
  targets: readonly string[],
  throughSquare: string | undefined
): string {
  return `${motif}|${attacker}|${[...targets].sort().join('+')}|${throughSquare ?? '-'}`;
}

type MotifCore = Omit<TacticalMotifInstance, 'motifInstanceKey' | 'firstSeenPly'>;

function instanceFrom(core: MotifCore): TacticalMotifInstance {
  return {
    ...core,
    motifInstanceKey: motifInstanceKeyFor(core.motif, core.squares.attacker, core.squares.targets, core.squares.throughSquare),
    // A single-ply call has no cross-ply history to compare against, so the
    // honest answer is "as far as this call knows, here". detectMotifs runs
    // the whole game in ply order and corrects this to the true first
    // observation — see withFirstSeenPlies.
    firstSeenPly: core.ply
  };
}

export function detectMotifsForPly(ply: PlyAnalysis, minMaterialValueForMotif: number): TacticalMotifInstance[] {
  const boardAfter = boardFromFen(ply.fenAfter);
  const attackerColor = ply.sideToMove;
  const instances: TacticalMotifInstance[] = [];
  const nextId = nextIdFactory(ply.ply);

  for (const fork of findForks(boardAfter, attackerColor, minMaterialValueForMotif)) {
    instances.push(
      instanceFrom({
        id: nextId('fork'),
        ply: ply.ply,
        motif: 'fork',
        squares: { attacker: fork.attacker, targets: fork.targets },
        geometryEvidence: {
          basis: 'chess-rule',
          sourcePlies: [ply.ply],
          note: `${fork.attacker} attacks ${fork.targets.length} qualifying targets: ${fork.targets.join(', ')}`
        }
      })
    );
  }

  for (const lineMotif of findLineMotifs(boardAfter, attackerColor)) {
    instances.push(
      instanceFrom({
        id: nextId(lineMotif.kind),
        ply: ply.ply,
        motif: lineMotif.kind,
        squares: { attacker: lineMotif.attacker, targets: [lineMotif.target], throughSquare: lineMotif.through },
        geometryEvidence: {
          basis: 'chess-rule',
          sourcePlies: [ply.ply],
          note: `${lineMotif.kind}: ${lineMotif.attacker} -> ${lineMotif.through} -> ${lineMotif.target}`
        }
      })
    );
  }

  const vacatedSquare = ply.movePlayedUci.slice(0, 2);
  for (const discovery of findDiscoveries(boardAfter, vacatedSquare, attackerColor)) {
    instances.push(
      instanceFrom({
        id: nextId('discovery'),
        ply: ply.ply,
        motif: 'discovery',
        squares: { attacker: discovery.attacker, targets: [discovery.target], throughSquare: vacatedSquare },
        geometryEvidence: {
          basis: 'chess-rule',
          sourcePlies: [ply.ply],
          note: `discovered attack ${discovery.attacker} -> ${discovery.target} via vacated ${vacatedSquare}`
        }
      })
    );
  }

  return instances;
}

/** Stage 2. Pure function: reuses the ply's own swingForMoverCp, no engine call. */
export function confirmMotifSignificance(instance: TacticalMotifInstance, swingForMoverCp: number): TacticalMotifInstance {
  if (swingForMoverCp <= 0) return instance;
  return {
    ...instance,
    significanceEvidence: {
      basis: 'engine-eval',
      sourcePlies: [instance.ply],
      note: `swingForMoverCp=${swingForMoverCp} on the triggering ply supports this motif realizing value`
    }
  };
}

/**
 * Phase 15 — resolves firstSeenPly across the whole game. Instances arrive
 * in ply order, so the first time a motifInstanceKey is seen is by
 * construction its earliest occurrence.
 */
function withFirstSeenPlies(instances: readonly TacticalMotifInstance[]): TacticalMotifInstance[] {
  const firstSeen = new Map<string, number>();
  return instances.map((instance) => {
    const existing = firstSeen.get(instance.motifInstanceKey);
    if (existing === undefined) {
      firstSeen.set(instance.motifInstanceKey, instance.ply);
      return instance;
    }
    return { ...instance, firstSeenPly: existing };
  });
}

/** Runs both stages over every ply, in ply order, with deterministic per-ply ID sequencing. */
export function detectMotifs(plies: readonly PlyAnalysis[], minMaterialValueForMotif: number): TacticalMotifInstance[] {
  const result: TacticalMotifInstance[] = [];
  for (const ply of plies) {
    for (const instance of detectMotifsForPly(ply, minMaterialValueForMotif)) {
      result.push(confirmMotifSignificance(instance, ply.swingForMoverCp));
    }
  }
  return withFirstSeenPlies(result);
}
