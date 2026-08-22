import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import type { AnalysisEngine } from './AnalysisEngine';
import type { AnalysisSettings, PositionEvaluation } from './types';
import { fromUciScore } from './evaluation';
import { foldInfoLines, parseBestMoveLine } from './uci';
import { createEngineWorkerUrls, loadEngineAssets, type EngineWorkerUrls } from './engineAssets';
import {
  analysisCancelledError,
  engineLoadError,
  engineProtocolError,
  engineTimeoutError
} from './analysisErrors';
import type { Color } from '../chess/ChessEngine';

const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Whose turn it is according to a FEN's side-to-move field — needed to apply the sign convention. */
function sideToMoveFromFen(fen: string): Color {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/**
 * Renders a Worker-level `error` event into something a human (or an
 * AppError.cause reader) can actually act on. Browsers vary in how much they
 * expose here — `event.error` can be null across the worker boundary — so
 * this falls back through message/filename/line before giving up.
 */
function describeWorkerError(event: ErrorEvent): string {
  const message =
    event.error instanceof Error ? event.error.message : event.message || 'unknown worker error';
  const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
  return `${message}${location}`;
}

/**
 * Stockfish running in a dedicated Web Worker, speaking UCI over postMessage.
 *
 * Everything expensive happens off the main thread: the UI keeps rendering
 * and stays interactive (including the Cancel button) while a full game is
 * being analysed. Nothing here blocks, spins, or busy-waits.
 *
 * The engine is single-threaded by build (stockfish-18-lite-single), so it
 * needs no SharedArrayBuffer and therefore no COOP/COEP headers — which is
 * what allows it to run in a plain static deployment and in the Artifact
 * sandbox alike.
 */
export class StockfishAnalysisEngine implements AnalysisEngine {
  private worker: Worker | null = null;
  private urls: EngineWorkerUrls | null = null;

  /** Set while an evaluation is in flight; receives every line the engine emits. */
  private activeListener: ((line: string) => void) | null = null;
  /** Invoked by cancel() to reject whatever evaluation is currently pending. */
  private cancelActive: (() => void) | null = null;
  /**
   * Invoked from worker.onerror to fail whatever is currently pending
   * (handshake or an in-flight evaluation) with the real underlying error,
   * instead of leaving it to run out the clock on a generic timeout.
   */
  private failActive: ((detail: string) => void) | null = null;
  private disposed = false;

  async init(): Promise<Result<void, AppError>> {
    if (this.disposed) return err(engineLoadError('engine was disposed'));
    if (this.worker) return ok(undefined);

    try {
      const assets = await loadEngineAssets();
      const urls = createEngineWorkerUrls(assets);
      const worker = new Worker(urls.workerUrl);

      this.worker = worker;
      this.urls = urls;

      worker.onmessage = (event: MessageEvent) => {
        const line = typeof event.data === 'string' ? event.data : String(event.data);
        this.activeListener?.(line);
      };
      worker.onerror = (event: ErrorEvent) => {
        // Prevent this from also surfacing as an unhandled browser-level
        // error/console entry on top of the one we're about to report.
        event.preventDefault();
        this.failActive?.(describeWorkerError(event));
      };

      await this.handshake(worker);
      return ok(undefined);
    } catch (cause) {
      this.teardown();
      return err(engineLoadError(cause));
    }
  }

  /**
   * Sends `uci` then `isready` and waits for `uciok` + `readyok`, so the
   * engine is genuinely warm. Tracks which of the two it's waiting on, and
   * reacts to worker.onerror, so a failure here reports exactly which stage
   * never arrived and, when the browser gives us one, the real underlying
   * error — rather than a bare 30-second timeout with no diagnostic value.
   */
  private handshake(worker: Worker): Promise<void> {
    return new Promise((resolve, reject) => {
      let sawUciOk = false;
      let stage: 'awaiting uciok' | 'awaiting readyok' = 'awaiting uciok';

      const cleanup = (): void => {
        clearTimeout(timer);
        this.activeListener = null;
        this.failActive = null;
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`engine handshake timed out (${stage})`));
      }, HANDSHAKE_TIMEOUT_MS);

      this.failActive = (detail: string) => {
        cleanup();
        reject(new Error(`worker error during handshake (${stage}): ${detail}`));
      };

      this.activeListener = (line: string) => {
        if (line === 'uciok') {
          sawUciOk = true;
          stage = 'awaiting readyok';
          worker.postMessage('isready');
        } else if (line === 'readyok' && sawUciOk) {
          cleanup();
          resolve();
        }
      };

      worker.postMessage('uci');
    });
  }

  async evaluatePosition(
    fen: string,
    settings: AnalysisSettings
  ): Promise<Result<PositionEvaluation, AppError>> {
    if (this.disposed) return err(engineLoadError('engine was disposed'));
    const worker = this.worker;
    if (!worker) return err(engineLoadError('engine not initialised'));

    const infoLines: string[] = [];

    type Outcome =
      | { status: 'done'; bestMove: string | null }
      | { status: 'cancelled' }
      | { status: 'timeout' }
      | { status: 'worker-error'; detail: string };

    const outcome = await new Promise<Outcome>((resolve) => {
      const finish = (value: Outcome): void => {
        clearTimeout(timer);
        this.activeListener = null;
        this.cancelActive = null;
        this.failActive = null;
        resolve(value);
      };

      const timer = setTimeout(() => {
        // Ask the engine to stop searching; whatever it has found is discarded.
        worker.postMessage('stop');
        finish({ status: 'timeout' });
      }, settings.maxTimeMsPerPosition);

      this.cancelActive = () => {
        worker.postMessage('stop');
        finish({ status: 'cancelled' });
      };

      this.failActive = (detail: string) => finish({ status: 'worker-error', detail });

      this.activeListener = (line: string) => {
        if (line.startsWith('info')) {
          infoLines.push(line);
          return;
        }
        const bestMove = parseBestMoveLine(line);
        if (bestMove) {
          finish({ status: 'done', bestMove: bestMove.bestMove });
        }
      };

      // `ucinewgame` clears the engine's internal state between positions so
      // each evaluation is independent of the order positions were fed in —
      // without it, hash carry-over makes results depend on history.
      worker.postMessage('ucinewgame');
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${settings.depth}`);
    });

    if (outcome.status === 'cancelled') return err(analysisCancelledError());
    if (outcome.status === 'timeout') return err(engineTimeoutError(fen));
    if (outcome.status === 'worker-error') {
      return err(engineProtocolError(`worker error while analysing ${fen}: ${outcome.detail}`));
    }

    const best = foldInfoLines(infoLines);
    if (!best || best.score === undefined) {
      // A terminal position (checkmate/stalemate) legitimately produces no
      // score: the engine reports `bestmove (none)` and searches nothing.
      // That is not an error, but it also is not an evaluation, so the caller
      // is told plainly rather than being handed a fabricated 0.00.
      return err(engineProtocolError(`no evaluation returned for position: ${fen}`));
    }

    return ok({
      evaluation: fromUciScore(best.score, sideToMoveFromFen(fen)),
      bestMove: outcome.bestMove,
      principalVariation: best.principalVariation ?? [],
      depth: best.depth ?? settings.depth
    });
  }

  cancel(): void {
    this.cancelActive?.();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.teardown();
  }

  private teardown(): void {
    this.worker?.terminate();
    this.worker = null;
    this.urls?.revoke();
    this.urls = null;
    this.activeListener = null;
    this.cancelActive = null;
    this.failActive = null;
  }
}
