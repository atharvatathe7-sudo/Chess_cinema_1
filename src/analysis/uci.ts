import type { UciScore } from './evaluation';

/**
 * Parsing for the UCI text protocol. This module is the containment boundary
 * for engine-specific wire format: Stockfish's raw output strings are turned
 * into our own types here and nowhere else, so no Stockfish vocabulary leaks
 * into the rest of the application.
 *
 * Pure and synchronous — no worker, no engine, fully unit-testable.
 */

/** A parsed `info ...` search line. Fields absent from the line stay undefined. */
export interface UciInfo {
  readonly depth?: number;
  readonly score?: UciScore;
  readonly principalVariation?: readonly string[];
  /** True for `info ... upperbound|lowerbound`, whose scores are not exact and should be ignored. */
  readonly bound?: 'upper' | 'lower';
  /** multipv index, 1 for the primary line. Lines beyond 1 are alternatives. */
  readonly multipv?: number;
}

/**
 * Parses an `info` line, e.g.
 *   info depth 10 seldepth 18 multipv 1 score cp 46 nodes 32689 time 90 pv g1f3 g8f6
 * Returns null for any line that is not a parseable `info` search line
 * (the engine also emits `info string ...` chatter, which carries no score).
 */
export function parseInfoLine(line: string): UciInfo | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return null;

  const info: {
    depth?: number;
    score?: UciScore;
    principalVariation?: string[];
    bound?: 'upper' | 'lower';
    multipv?: number;
  } = {};

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === 'depth') {
      const value = Number(tokens[i + 1]);
      if (Number.isFinite(value)) info.depth = value;
      i++;
    } else if (token === 'multipv') {
      const value = Number(tokens[i + 1]);
      if (Number.isFinite(value)) info.multipv = value;
      i++;
    } else if (token === 'score') {
      const kind = tokens[i + 1];
      const value = Number(tokens[i + 2]);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(value)) {
        info.score = { kind, value };
        i += 2;
      }
    } else if (token === 'upperbound') {
      info.bound = 'upper';
    } else if (token === 'lowerbound') {
      info.bound = 'lower';
    } else if (token === 'pv') {
      // `pv` is always last: everything after it is the variation.
      const moves = tokens.slice(i + 1).filter((m) => m.length > 0);
      if (moves.length > 0) info.principalVariation = moves;
      break;
    }
  }

  // A search line with no score and no depth carries nothing we can use.
  if (info.score === undefined && info.depth === undefined) return null;
  return info;
}

/**
 * Parses a `bestmove` line, e.g. `bestmove g1f3 ponder g8f6`.
 * Returns null if the line is not a bestmove line. Returns null for the
 * move itself when the engine reports `bestmove (none)` — which it does in
 * terminal positions (checkmate/stalemate), where there is no legal move.
 */
export function parseBestMoveLine(line: string): { bestMove: string | null } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'bestmove') return null;
  const move = tokens[1];
  if (move === undefined || move === '(none)' || move === 'NULL') {
    return { bestMove: null };
  }
  return { bestMove: move };
}

/**
 * Folds a stream of `info` lines into the best available evaluation for a
 * position: the deepest exact primary-variation score seen. Bound-limited
 * lines (`upperbound`/`lowerbound`) are skipped because their scores are
 * search artefacts rather than real evaluations, and multipv lines beyond
 * the first describe alternative moves rather than the position's value.
 */
export function foldInfoLines(lines: readonly string[]): UciInfo | null {
  let best: UciInfo | null = null;

  for (const line of lines) {
    const info = parseInfoLine(line);
    if (!info || info.score === undefined) continue;
    if (info.bound !== undefined) continue;
    if (info.multipv !== undefined && info.multipv !== 1) continue;

    if (best === null || (info.depth ?? 0) >= (best.depth ?? 0)) {
      best = info;
    }
  }

  return best;
}
