import type { ChessEngine } from '../chess/ChessEngine';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { invalidPgnError } from '../chess/engineErrors';
import { assignPieceIdentities } from './assignPieceIdentities';
import type { GameHeaders, GameRecord, PositionSnapshot } from './types';

/** PGN's Seven Tag Roster convention: "?" means "unknown/not provided". */
function known(value: string | undefined): string | undefined {
  return value && value !== '?' ? value : undefined;
}

function parseHeaders(raw: Record<string, string>): GameHeaders {
  const headers: GameHeaders = {};
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
