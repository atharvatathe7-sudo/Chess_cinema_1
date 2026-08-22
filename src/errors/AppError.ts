export type AppErrorSeverity = 'fatal' | 'recoverable';

export interface AppError {
  code: string;
  severity: AppErrorSeverity;
  message: string;
  cause?: unknown;
}

export function appError(
  code: string,
  severity: AppErrorSeverity,
  message: string,
  cause?: unknown
): AppError {
  return { code, severity, message, cause };
}
