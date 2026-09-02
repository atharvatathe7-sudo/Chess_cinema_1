import type { ChessEngine } from '../chess/ChessEngine';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { invalidPgnError } from '../chess/engineErrors';
import { assignPieceIdentities } from './assignPieceIdentities';
import type { GameHeaders, GameRecord, PositionSnapshot, TerminationKind } from './types';

/** PGN's Seven Tag Roster convention: "?" means "unknown/not provided". */
function known(value: string | undefined): string | undefined {
  return value && value !== '?' ? value : undefined;
}

/**
 * Ordered substring rules for the [Termination] tag. There is no PGN
 * standard for this field's wording — Chess.com writes "X won by
 * resignation" / "Game drawn by timeout vs insufficient material", Lichess
 * writes "Normal" / "Time forfeit" — so this classifies by recognisable
 * phrases rather than pretending a grammar exists.
 *
 * Order is significant and load-bearing: the more specific compound forms
 * must be tested before their own substrings, or "timeout vs insufficient
 * material" would classify as plain 'timeout' (or 'insufficient-material',
 * depending on scan order) and lose exactly the distinction that makes it
 * worth parsing.
 *
 * Anything unmatched classifies as 'unknown' and keeps its raw text — an
 * unfamiliar PGN must never fail to parse.
 */
const TERMINATION_RULES: readonly { readonly match: readonly string[]; readonly kind: TerminationKind }[] = [
  { match: ['timeout vs insufficient material', 'time forfeit vs insufficient material'], kind: 'timeout-vs-insufficient-material' },
  { match: ['insufficient material'], kind: 'insufficient-material' },
  { match: ['checkmate', 'mate'], kind: 'checkmate' },
  { match: ['stalemate'], kind: 'stalemate' },
  { match: ['resignation', 'resigned'], kind: 'resignation' },
  { match: ['timeout', 'time forfeit', 'on time', 'won on time', 'abandoned'], kind: 'timeout' },
  { match: ['agreement', 'agreed'], kind: 'agreement' },
  { match: ['repetition'], kind: 'repetition' },
  { match: ['50-move', 'fifty-move', '50 move', 'fifty move'], kind: 'fifty-move' }
];

/**
 * 'stalemate' contains the substring "mate", so the checkmate rule above
 * would swallow it if the rules were scanned naively. Rather than reorder
 * (which would leave "checkmate" matching the stalemate rule's own scan in
 * some other wording), stalemate is checked explicitly first.
 */
export function classifyTermination(raw: string | undefined): TerminationKind {
  if (raw === undefined) return 'absent';
  const text = raw.toLowerCase();
  if (text.trim() === '') return 'absent';
  if (text.includes('stalemate')) return 'stalemate';
  for (const rule of TERMINATION_RULES) {
    if (rule.match.some((phrase) => text.includes(phrase))) return rule.kind;
  }
  return 'unknown';
}

function parseHeaders(raw: Record<string, string>): GameHeaders {
  const termination = classifyTermination(raw.Termination);
  const headers: GameHeaders = { termination };
  if (raw.Termination !== undefined && raw.Termination.trim() !== '') {
    headers.terminationRaw = raw.Termination;
  }
  const white = known(raw.White);
  const black = known(raw.Black);
  const whiteElo = known(raw.WhiteElo);
  const blackElo = known(raw.BlackElo);
  const result = known(raw.Result);
  const event = known(raw.Event);
  if (white) headers.white = white;
  if (black) headers.black = black;
  if (whiteElo) headers.whiteElo = Number(whiteElo);
  if (blackElo) headers.blackElo = Number(blackElo);
  if (result) headers.result = result;
  if (event) headers.event = event;
  return headers;
}

/**
 * Parses PGN text into a GameRecord: normalized move history (with
 * stable PieceIds already assigned) plus a FEN snapshot for every ply.
 * This is the sole intended input to timeline generation.
 *
 * Delegates legality/parsing to the given ChessEngine — never touches
 * chess.js directly — and returns a typed Result rather than throwing,
 * so malformed PGN is a recoverable, surfaced error, not a silent
 * partial parse.
 */
export function parsePgn(text: string, engine: ChessEngine): Result<GameRecord, AppError> {
  const loadResult = engine.loadPgn(text);
  if (!loadResult.ok) return err(loadResult.error);

  const engineMoves = loadResult.value;
  if (engineMoves.length === 0) {
    return err(invalidPgnError('PGN contained no moves'));
  }

  let moves;
  try {
    moves = assignPieceIdentities(engineMoves);
  } catch (cause) {
    return err(invalidPgnError(cause));
  }

  const positions: PositionSnapshot[] = [{ ply: 0, fen: engineMoves[0]!.before }];
  engineMoves.forEach((m, i) => {
    positions.push({ ply: i + 1, fen: m.after });
  });

  const headers = parseHeaders(engine.headers());

  return ok({ headers, positions, moves });
}
