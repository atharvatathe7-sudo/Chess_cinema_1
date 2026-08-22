import { appError, type AppError } from '../errors/AppError';

export function assetLoadError(cause?: unknown): AppError {
  return appError(
    'assets/piece-set-load-failed',
    'fatal',
    'The piece art failed to load. Chess Cinema cannot render a board without it.',
    cause
  );
}
