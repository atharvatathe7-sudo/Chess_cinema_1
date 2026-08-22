import type { PieceType } from '../chess/ChessEngine';
import type { PieceId, RookMove } from '../pgn/types';

export interface MoveBeat {
  kind: 'move';
  /** Standard Algebraic Notation, for UI/history display only — never used to derive position or timing. */
  san: string;
  pieceId: PieceId;
  from: string;
  to: string;
  atMs: number;
  durationMs: number;
  capturedPieceId?: PieceId;
  promotion?: PieceType;
  isEnPassant: boolean;
  rookMove?: RookMove;
  /** Index into GameRecord.positions for the position AFTER this beat completes. */
  resultingPly: number;
}

export interface Annotation {
  type: 'arrow' | 'highlight' | 'label';
  squares: string[];
  color: string;
  /** Open extension point for future motif/story annotations — not consumed in Phase 1. */
  meta?: Record<string, unknown>;
}

export interface AnnotationBeat {
  kind: 'annotation';
  annotation: Annotation;
  atMs: number;
  untilMs: number;
}

export type Beat = MoveBeat | AnnotationBeat;

export interface CameraKeyframe {
  atMs: number;
  /** Board-space center, in 0..8 units (see render/coords.ts). (4, 4) is the board's geometric center. */
  centerX: number;
  centerY: number;
  /** 1 = whole board fits the frame. >1 zooms in. */
  zoom: number;
}

export interface CameraPlan {
  keyframes: CameraKeyframe[];
}

export interface Scene {
  id: string;
  /** FEN of the position at the start of this scene, before any of its beats. */
  startPositionFen: string;
  /** Index into GameRecord.positions matching startPositionFen. */
  startPly: number;
  beats: Beat[];
  cameraPlan: CameraPlan;
  durationMs: number;
}

export interface Timeline {
  scenes: Scene[];
}
