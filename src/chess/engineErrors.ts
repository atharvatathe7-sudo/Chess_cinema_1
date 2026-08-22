import type { AppError } from '../errors/AppError';
import { appError } from '../errors/AppError';

export function engineLoadError(cause?: unknown): AppError {
  return appError(
    'chess/engine-load-failed',
    'fatal',
    'The chess rules engine failed to load. Chess Cinema cannot verify move legality without it.',
    cause
  );
}

export function illegalMoveError(from: string, to: string): AppError {
  return appError(
    'chess/illegal-move',
    'recoverable',
    `Illegal move: ${from} -> ${to}.`
  );
}

export function invalidFenError(fen: string, cause?: unknown): AppError {
  return appError('chess/invalid-fen', 'recoverable', `Invalid FEN: "${fen}".`, cause);
}

export function invalidPgnError(cause?: unknown): AppError {
  return appError('chess/invalid-pgn', 'recoverable', 'Invalid or unparseable PGN.', cause);
}
