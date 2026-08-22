import { appError, type AppError } from '../errors/AppError';

export function engineLoadError(cause?: unknown): AppError {
  return appError(
    'analysis/engine-load-failed',
    'fatal',
    'The analysis engine failed to load. Game analysis is unavailable.',
    cause
  );
}

export function engineTimeoutError(fen: string): AppError {
  return appError(
    'analysis/timeout',
    'recoverable',
    `The analysis engine did not respond in time for position: ${fen}`
  );
}

export function analysisCancelledError(): AppError {
  return appError('analysis/cancelled', 'recoverable', 'Analysis was cancelled.');
}

export function engineProtocolError(detail: string): AppError {
  return appError('analysis/protocol', 'recoverable', `Unexpected analysis engine response: ${detail}`);
}
