import type { Evaluation, GameAnalysis } from '../analysis/types';
import type { GameRecord, TerminationKind } from '../pgn/types';
import { boardFromFen, materialBalance } from '../understanding/geometry';

/**
 * Phase 15 — GameOutcome: what actually happened at the end of this game.
 *
 * This is the fact the story layer never previously had. GameRecord.headers
 * carried `result` from the very first phase and nothing in src/ ever read
 * it; the [Termination] tag was discarded during parsing entirely. Every
 * downstream decision about whether a candidate "explains the result" is
 * meaningless without this object, so it is resolved once, first, and
 * threaded through story selection.
 *
 * It deliberately keeps THREE cases apart rather than flattening them into
 * "the game ended somehow":
 *
 *   1. board terminal — checkmate or stalemate is on the board. The engine
 *      saw it. Authoritative, confidence 1.
 *   2. off-board result — the board is not terminal but the PGN says how the
 *      game ended (resignation, timeout, agreement, ...). Trusted, but a
 *      claim by the file rather than something we verified.
 *   3. unsupported/incomplete — a result is asserted with nothing to back it:
 *      no terminal position, no termination reason. The honest response is
 *      to say so, not to invent a narrative for it.
 *
 * A decisive `result` alone is NEVER promoted to 'resignation'. That
 * inference is exactly the kind of plausible-sounding fabrication this phase
 * exists to remove: "1-0 with no terminal position" genuinely might be a
 * resignation, or a truncated PGN, or an import artefact, and we cannot tell.
 */

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export type OutcomeSource = 'engine-terminal' | 'termination-tag' | 'result-header' | 'none';

export interface GameOutcome {
  readonly result: GameResult | null;
  readonly termination: TerminationKind;
  /** True only when the final position is genuinely terminal on the board. */
  readonly onBoard: boolean;
  readonly finalEvaluation: Evaluation;
  /** White-relative material balance of the final position, geometry.ts's PIECE_VALUE scale. */
  readonly finalMaterialDiff: number;
  readonly source: OutcomeSource;
  /** How much this outcome can be relied on: 1 = the engine saw it, 0 = nothing is known. */
  readonly confidence: number;
}

const CONFIDENCE_BY_SOURCE: Readonly<Record<OutcomeSource, number>> = {
  'engine-terminal': 1,
  'termination-tag': 0.9,
  'result-header': 0.4,
  none: 0
};

/** No analysed plies at all — there is no final position to describe. */
const NO_EVALUATION: Evaluation = { kind: 'cp', cp: 0 };

/** Normalises the optional header field; see GameHeaders.termination. */
export function terminationOf(game: GameRecord): TerminationKind {
  return game.headers.termination ?? 'absent';
}

/**
 * Material balance of a position, or 0 when the FEN cannot be read.
 *
 * This function only DESCRIBES an ending; it must never be the thing that
 * makes a pipeline throw. Unreadable position text is a missing measurement,
 * not an error condition, and 0 is the honest reading of "we could not tell"
 * — isUnsupportedOutcome then treats it as uncorroborating, which is the
 * conservative direction.
 */
function safeMaterialBalance(fen: string): number {
  try {
    return materialBalance(boardFromFen(fen));
  } catch {
    return 0;
  }
}

function resultOf(game: GameRecord): GameResult | null {
  const raw = game.headers.result;
  if (raw === '1-0' || raw === '0-1' || raw === '1/2-1/2' || raw === '*') return raw;
  return null;
}

function resultFromTerminal(evaluation: Evaluation): GameResult | null {
  if (evaluation.kind !== 'terminal') return null;
  if (evaluation.result === 'white-wins') return '1-0';
  if (evaluation.result === 'black-wins') return '0-1';
  return '1/2-1/2';
}

/**
 * The board-terminal termination. A terminal win is always checkmate (the
 * only way a game ends decisively on the board), and a terminal draw is
 * 'stalemate' exactly when analyzeGame.ts's own terminalEvaluation said so.
 * Any other terminal draw (repetition, 50-move, insufficient material —
 * which ChessEngine.status() does not currently separate) falls back to the
 * PGN's own tag rather than being guessed at.
 */
function terminationFromTerminal(evaluation: Evaluation, tagged: TerminationKind): TerminationKind {
  if (evaluation.kind !== 'terminal') return tagged;
  if (evaluation.result !== 'draw') return 'checkmate';
  if (evaluation.drawReason === 'stalemate') return 'stalemate';
  return tagged === 'absent' || tagged === 'unknown' ? 'unknown' : tagged;
}

/**
 * Precedence: engine terminal -> [Termination] tag -> result header -> none.
 * Each step only supplies what the step above could not.
 */
export function resolveGameOutcome(game: GameRecord, analysis: GameAnalysis): GameOutcome {
  const finalPly = analysis.plies[analysis.plies.length - 1];
  const finalEvaluation = finalPly?.evaluationAfter ?? NO_EVALUATION;
  const finalMaterialDiff = finalPly ? safeMaterialBalance(finalPly.fenAfter) : 0;

  const tagged = terminationOf(game);
  const headerResult = resultOf(game);
  const onBoard = finalEvaluation.kind === 'terminal';

  if (onBoard) {
    return {
      result: resultFromTerminal(finalEvaluation) ?? headerResult,
      termination: terminationFromTerminal(finalEvaluation, tagged),
      onBoard: true,
      finalEvaluation,
      finalMaterialDiff,
      source: 'engine-terminal',
      confidence: CONFIDENCE_BY_SOURCE['engine-terminal']
    };
  }

  if (tagged !== 'absent' && tagged !== 'unknown') {
    return {
      result: headerResult,
      termination: tagged,
      onBoard: false,
      finalEvaluation,
      finalMaterialDiff,
      source: 'termination-tag',
      confidence: CONFIDENCE_BY_SOURCE['termination-tag']
    };
  }

  if (headerResult !== null && headerResult !== '*') {
    return {
      result: headerResult,
      // Deliberately NOT 'resignation'. A decisive result with no terminal
      // position and no tag tells us who is recorded as winning, and nothing
      // whatsoever about how. 'unknown' is kept when a tag existed but was
      // unrecognised, so that evidence is not thrown away.
      termination: tagged,
      onBoard: false,
      finalEvaluation,
      finalMaterialDiff,
      source: 'result-header',
      confidence: CONFIDENCE_BY_SOURCE['result-header']
    };
  }

  return {
    result: headerResult,
    termination: tagged,
    onBoard: false,
    finalEvaluation,
    finalMaterialDiff,
    source: 'none',
    confidence: CONFIDENCE_BY_SOURCE.none
  };
}

// ============================================================
// The three cases, as explicit predicates
// ============================================================

export function isBoardTerminal(outcome: GameOutcome): boolean {
  return outcome.onBoard;
}

export function isOffBoardResult(outcome: GameOutcome): boolean {
  return !outcome.onBoard && outcome.source === 'termination-tag';
}

/** cp magnitude beyond which the final position corroborates a decisive result. */
const CORROBORATING_EVAL_CP = 150;
/** Material magnitude beyond which the final position corroborates a decisive result. */
const CORROBORATING_MATERIAL = 200;

/**
 * True when a result is asserted that nothing observable supports: no
 * terminal position, no termination reason, and a final position that does
 * not itself look decided. This is the R2 abstention precondition — see
 * storyCandidates.ts, which additionally requires that no admissible
 * candidate survived before actually abstaining.
 */
export function isUnsupportedOutcome(outcome: GameOutcome): boolean {
  // "Unsupported" means a result was ASSERTED and nothing backs it. A game
  // that claims no result at all is not making a claim to be unsupported —
  // it is simply unfinished or unlabelled, and is judged on its events like
  // any other.
  if (outcome.result === null || outcome.result === '*') return false;
  if (outcome.onBoard) return false;
  if (outcome.termination !== 'absent' && outcome.termination !== 'unknown') return false;
  const evaluation = outcome.finalEvaluation;
  const evalMagnitude = evaluation.kind === 'cp' ? Math.abs(evaluation.cp) : evaluation.kind === 'mate' ? Infinity : Infinity;
  if (evalMagnitude >= CORROBORATING_EVAL_CP) return false;
  if (Math.abs(outcome.finalMaterialDiff) >= CORROBORATING_MATERIAL) return false;
  return true;
}

/** The side the recorded result awards the game to, or null for a draw/unknown. */
export function winnerOf(outcome: GameOutcome): 'w' | 'b' | null {
  if (outcome.result === '1-0') return 'w';
  if (outcome.result === '0-1') return 'b';
  return null;
}
