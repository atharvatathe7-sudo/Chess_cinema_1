import type { GameAnalysis } from '../analysis/types';
import type { GameRecord } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import { DEFAULT_STORY_SETTINGS, STORY_SCHEMA_VERSION, type StoryPlan, type StorySettings } from './types';
import { selectCentralConflict } from './centralConflict';
import { buildBeats } from './beats';
import { classifyMoveTreatment } from './retention';
import { buildExplanationOpportunities } from './bestAlternative';
import { buildArchetypeSignals } from './archetypes';
import { buildPieceContributions } from './pieceContribution';

/**
 * Top-level Phase 2.3 orchestration: (GameRecord, GameAnalysis,
 * GameUnderstanding) -> StoryPlan. Deliberately synchronous and free of any
 * AnalysisEngine dependency — every input is already fully materialized, so
 * there is no IO to await and no engine call this function could make even
 * by accident. Determinism therefore follows from structure, not merely
 * from testing: given the same inputs and settings, every step here is a
 * pure computation over already-fixed data.
 *
 * Selects and references existing Phase 2.2/2.2.1 evidence; never
 * re-derives chess facts Phase 2.2 already computed, and never widens the
 * engine budget those facts were produced under.
 */
export function buildStoryPlan(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  settings: StorySettings = DEFAULT_STORY_SETTINGS
): StoryPlan {
  if (understanding.plies.length === 0) {
    return {
      schemaVersion: STORY_SCHEMA_VERSION,
      centralConflict: null,
      noConflictReason: 'no-turning-points',
      beats: [],
      moveTreatment: [],
      archetypeSignals: [],
      pieceContributions: [],
      explanationOpportunities: [],
      settings
    };
  }

  // Internal-consistency invariant, matching understandGame.ts's own
  // throw-on-mismatch precedent: game/analysis/understanding must all
  // describe the same GameRecord. A mismatch here is a caller bug, not a
  // recoverable runtime condition.
  const gamePlyNumbers = new Set(game.moves.map((m) => m.ply));
  for (const ps of understanding.plies) {
    if (!gamePlyNumbers.has(ps.ply)) {
      throw new Error(`buildStoryPlan: no MoveRecord for ply ${ps.ply} — game and understanding must come from the same GameRecord`);
    }
  }

  const { centralConflict, noConflictReason } = selectCentralConflict(understanding, settings);
  const beats = buildBeats(centralConflict, understanding);
  const archetypeSignals = buildArchetypeSignals(game, analysis, understanding, settings, beats);
  const moveTreatment = classifyMoveTreatment(understanding, beats, archetypeSignals);
  const explanationOpportunities = buildExplanationOpportunities(understanding);
  const pieceContributions = buildPieceContributions(game, understanding, beats, archetypeSignals);

  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    centralConflict,
    ...(noConflictReason ? { noConflictReason } : {}),
    beats,
    moveTreatment,
    archetypeSignals,
    pieceContributions,
    explanationOpportunities,
    settings
  };
}
