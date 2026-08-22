import { Chess } from 'chess.js';
import type { Color, PieceType } from '../chess/ChessEngine';

/**
 * Pure chess-board geometry: attack maps, line motifs (pin/skewer/battery),
 * forks, discovered attacks, static exchange evaluation, and king mobility.
 *
 * Deliberately independent of ChessEngine/ChessJsEngine — this module
 * constructs its own local chess.js instances and never touches the
 * ChessEngine interface or its one implementation, so Phase 1/1.1/2.1's
 * rules layer is completely unaffected by Phase 2.2 existing. Every
 * function here is pure and deterministic given a FEN/board: same input,
 * same output, always — this is chess-rule evidence, never engine opinion.
 *
 * Known, deliberate simplifications (documented rather than silently
 * assumed away):
 *   - staticExchangeEvaluation does not revalue X-ray attackers that are
 *     revealed as pieces are removed from the target square (a slider
 *     lined up behind another attacker of the same color). This covers the
 *     large majority of real captures correctly and is a standard,
 *     acceptable first-pass SEE simplification.
 *   - Battery detection confirms two aligned attacking pieces; it does not
 *     independently re-verify a valuable target lies beyond them (that is
 *     left to the threat/significance layer, which already checks targets
 *     via SEE).
 */

export interface BoardSquare {
  readonly square: string;
  readonly type: PieceType;
  readonly color: Color;
}

/** board[0] = rank 8 ... board[7] = rank 1, matching chess.js's own .board() layout. */
export type Board = readonly (readonly (BoardSquare | null)[])[];

export const PIECE_VALUE: Readonly<Record<PieceType, number>> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000
};

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];
const DIAGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
];
const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2]
];

function slidesOrthogonally(type: PieceType): boolean {
  return type === 'r' || type === 'q';
}
function slidesDiagonally(type: PieceType): boolean {
  return type === 'b' || type === 'q';
}
function inBounds(r: number, f: number): boolean {
  return r >= 0 && r < 8 && f >= 0 && f < 8;
}

export function squareName(fileIdx: number, rankFromTop: number): string {
  const file = String.fromCharCode('a'.charCodeAt(0) + fileIdx);
  const rank = 8 - rankFromTop;
  return `${file}${rank}`;
}

export function coordsOf(square: string): { readonly r: number; readonly f: number } {
  const f = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const r = 8 - Number(square[1]);
  return { r, f };
}

/** Parses a FEN into a board array via chess.js — the only place this module touches chess.js's own API surface. */
export function boardFromFen(fen: string): Board {
  const chess = new Chess(fen);
  return chess.board() as Board;
}

/** Squares a piece pseudo-legally attacks (respects blockers, ignores whether moving there is legal for its own king). */
export function attackSquaresFrom(
  board: Board,
  r: number,
  f: number
): ReadonlyArray<{ readonly r: number; readonly f: number }> {
  const piece = board[r]?.[f];
  if (!piece) return [];
  const result: { r: number; f: number }[] = [];

  if (piece.type === 'n') {
    for (const [dr, df] of KNIGHT_STEPS) {
      const rr = r + dr;
      const ff = f + df;
      if (inBounds(rr, ff)) result.push({ r: rr, f: ff });
    }
  } else if (piece.type === 'k') {
    for (const [dr, df] of [...ORTHOGONAL, ...DIAGONAL]) {
      const rr = r + dr;
      const ff = f + df;
      if (inBounds(rr, ff)) result.push({ r: rr, f: ff });
    }
  } else if (piece.type === 'p') {
    const dir = piece.color === 'w' ? -1 : 1; // board row 0 is rank 8: white advances toward row 0
    for (const df of [-1, 1]) {
      const rr = r + dir;
      const ff = f + df;
      if (inBounds(rr, ff)) result.push({ r: rr, f: ff });
    }
  } else {
    const dirs = [
      ...(slidesOrthogonally(piece.type) ? ORTHOGONAL : []),
      ...(slidesDiagonally(piece.type) ? DIAGONAL : [])
    ];
    for (const [dr, df] of dirs) {
      let rr = r + dr;
      let ff = f + df;
      while (inBounds(rr, ff)) {
        result.push({ r: rr, f: ff });
        if (board[rr]?.[ff]) break;
        rr += dr;
        ff += df;
      }
    }
  }
  return result;
}

export interface Attacker {
  readonly square: string;
  readonly type: PieceType;
}

export function attackersOf(board: Board, target: { readonly r: number; readonly f: number }, byColor: Color): Attacker[] {
  const result: Attacker[] = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r]?.[f];
      if (!piece || piece.color !== byColor) continue;
      const attacks = attackSquaresFrom(board, r, f);
      if (attacks.some((sq) => sq.r === target.r && sq.f === target.f)) {
        result.push({ square: squareName(f, r), type: piece.type });
      }
    }
  }
  return result;
}

/**
 * Static Exchange Evaluation: the net material change for `sideToCapture`
 * if a full capture sequence on `target` is played out, assuming each side
 * always recaptures with its least valuable attacker. Pure chess-rule
 * evidence — no engine call. See the module-level note on the X-ray
 * simplification.
 */
export function staticExchangeEvaluation(
  board: Board,
  target: { readonly r: number; readonly f: number },
  sideToCapture: Color
): number {
  const occupant = board[target.r]?.[target.f];

  const attackers: Record<Color, number[]> = {
    w: attackersOf(board, target, 'w')
      .map((a) => PIECE_VALUE[a.type])
      .sort((a, b) => a - b),
    b: attackersOf(board, target, 'b')
      .map((a) => PIECE_VALUE[a.type])
      .sort((a, b) => a - b)
  };

  // No attacker of sideToCapture means no capture is actually possible here
  // at all — without this guard, gains[0] below would default to the
  // target's own value and make an entirely undefended, unattacked square
  // look like a winning capture.
  if (attackers[sideToCapture].length === 0) return 0;

  const gains: number[] = [occupant ? PIECE_VALUE[occupant.type] : 0];
  let side = sideToCapture;
  let d = 0;
  while (attackers[side].length > 0) {
    const attackerValue = attackers[side].shift()!;
    d++;
    gains[d] = attackerValue - gains[d - 1]!;
    side = side === 'w' ? 'b' : 'w';
  }
  // Classic swap-algorithm unwind: pre-decrement-then-test, so a single
  // capture with no recapture leaves gains[0] untouched (a plain, unopposed
  // gain), and only chains of two or more captures get negamax-unwound.
  while (--d > 0) {
    gains[d - 1] = -Math.max(-gains[d - 1]!, gains[d]!);
  }
  return gains[0]!;
}

export interface ForkResult {
  readonly attacker: string;
  readonly targets: readonly string[];
}

/** A piece attacking 2+ enemy pieces at/above minValue (the king always counts, regardless of minValue). */
export function findForks(board: Board, attackerColor: Color, minValue: number): ForkResult[] {
  const defenderColor: Color = attackerColor === 'w' ? 'b' : 'w';
  const results: ForkResult[] = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r]?.[f];
      if (!piece || piece.color !== attackerColor) continue;
      const targets: string[] = [];
      for (const sq of attackSquaresFrom(board, r, f)) {
        const cell = board[sq.r]?.[sq.f];
        if (cell && cell.color === defenderColor && (cell.type === 'k' || PIECE_VALUE[cell.type] >= minValue)) {
          targets.push(squareName(sq.f, sq.r));
        }
      }
      if (targets.length >= 2) {
        results.push({ attacker: squareName(f, r), targets });
      }
    }
  }
  return results;
}

export interface LineMotifResult {
  readonly kind: 'pin' | 'skewer' | 'battery';
  readonly attacker: string;
  readonly through: string;
  readonly target: string;
}

/**
 * Ray-casts from every slider of attackerColor along its lines. Finding
 * [attacker] -> [defender piece A] -> [defender piece B] with nothing
 * between classifies as a pin (B is the king, or B's value >= A's — A
 * can't safely move) or a skewer (A is more valuable and not the king — A
 * will be forced off the line, exposing B). Finding
 * [attacker] -> [second attacker of the same color, able to slide the same
 * direction] classifies as a battery; `through` and `target` both name the
 * second piece, since confirming a further target beyond the pair is left
 * to the threat/significance layer (see the module-level note above).
 */
export function findLineMotifs(board: Board, attackerColor: Color): LineMotifResult[] {
  const defenderColor: Color = attackerColor === 'w' ? 'b' : 'w';
  const results: LineMotifResult[] = [];

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r]?.[f];
      if (!piece || piece.color !== attackerColor) continue;
      const dirs = [
        ...(slidesOrthogonally(piece.type) ? ORTHOGONAL : []),
        ...(slidesDiagonally(piece.type) ? DIAGONAL : [])
      ];
      for (const [dr, df] of dirs) {
        let rr = r + dr;
        let ff = f + df;
        let firstFound: { r: number; f: number; type: PieceType } | null = null;
        while (inBounds(rr, ff)) {
          const cell = board[rr]?.[ff];
          if (cell) {
            if (!firstFound) {
              if (cell.color === attackerColor) {
                // A friendly piece is the first thing found along this ray: either it
                // extends the battery (if it can also slide this direction) or it's a
                // dead blocker. Either way, nothing beyond it is reachable from here.
                const slidesThisWay = dr === 0 || df === 0 ? slidesOrthogonally(cell.type) : slidesDiagonally(cell.type);
                if (slidesThisWay) {
                  const secondSq = squareName(ff, rr);
                  results.push({ kind: 'battery', attacker: squareName(f, r), through: secondSq, target: secondSq });
                }
                break;
              }
              firstFound = { r: rr, f: ff, type: cell.type };
            } else {
              // Second piece along the ray, only reached when firstFound is defenderColor.
              if (cell.color === defenderColor) {
                const attackerSq = squareName(f, r);
                const nearSq = squareName(firstFound.f, firstFound.r);
                const farSq = squareName(ff, rr);
                const nearValue = PIECE_VALUE[firstFound.type];
                const farValue = PIECE_VALUE[cell.type];
                if (cell.type === 'k' || farValue >= nearValue) {
                  results.push({ kind: 'pin', attacker: attackerSq, through: nearSq, target: farSq });
                } else {
                  results.push({ kind: 'skewer', attacker: attackerSq, through: nearSq, target: farSq });
                }
              }
              break;
            }
          }
          rr += dr;
          ff += df;
        }
      }
    }
  }
  return results;
}

export interface DiscoveryResult {
  readonly attacker: string;
  readonly target: string;
}

/**
 * Finds friendly sliders (of movingColor) whose ray now passes cleanly
 * through the square just vacated by a move and hits an enemy piece —
 * i.e. a discovered attack revealed by that move. Operates on the
 * post-move board only: the vacated square is, by construction, exactly
 * where the blocker used to be.
 */
export function findDiscoveries(boardAfter: Board, vacatedSquare: string, movingColor: Color): DiscoveryResult[] {
  const { r: vr, f: vf } = coordsOf(vacatedSquare);
  if (boardAfter[vr]?.[vf]) return [];
  const defenderColor: Color = movingColor === 'w' ? 'b' : 'w';
  const results: DiscoveryResult[] = [];

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = boardAfter[r]?.[f];
      if (!piece || piece.color !== movingColor) continue;
      if (!slidesOrthogonally(piece.type) && !slidesDiagonally(piece.type)) continue;
      const alignedOrthogonally = r === vr || f === vf;
      const alignedDiagonally = Math.abs(vr - r) === Math.abs(vf - f) && vr !== r;
      if (!alignedOrthogonally && !alignedDiagonally) continue;
      const dr = Math.sign(vr - r);
      const df = Math.sign(vf - f);
      if (dr === 0 && df === 0) continue;
      const canSlideThisDir = dr === 0 || df === 0 ? slidesOrthogonally(piece.type) : slidesDiagonally(piece.type);
      if (!canSlideThisDir) continue;

      let rr = r + dr;
      let ff = f + df;
      let passedVacated = false;
      while (inBounds(rr, ff)) {
        if (rr === vr && ff === vf) {
          passedVacated = true;
          rr += dr;
          ff += df;
          continue;
        }
        const cell = boardAfter[rr]?.[ff];
        if (cell) {
          if (passedVacated && cell.color === defenderColor) {
            results.push({ attacker: squareName(f, r), target: squareName(ff, rr) });
          }
          break;
        }
        rr += dr;
        ff += df;
      }
    }
  }
  return results;
}

/**
 * Legal escape squares for `color`'s king, via chess.js's own legal-move
 * generation (which already excludes moves into check — exactly what
 * "legal escape square" means). Only meaningful when it is actually
 * `color`'s turn in this FEN, since chess.js only generates legal moves
 * for the side to move; returns an empty array otherwise rather than
 * guessing.
 */
export function legalKingEscapeSquares(fen: string, color: Color): readonly string[] {
  const chess = new Chess(fen);
  if (chess.turn() !== color) return [];
  const board = chess.board();
  let kingSquare: string | null = null;
  for (const row of board) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) kingSquare = cell.square;
    }
  }
  if (!kingSquare) return [];
  const moves = chess.moves({ square: kingSquare as never, verbose: true }) as ReadonlyArray<{ to: string }>;
  return moves.map((m) => m.to);
}

/** Net material on the board, White minus Black, in the same PIECE_VALUE units. */
export function materialBalance(board: Board): number {
  let total = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      total += cell.color === 'w' ? PIECE_VALUE[cell.type] : -PIECE_VALUE[cell.type];
    }
  }
  return total;
}

/** Total material remaining on the board, both sides combined, excluding kings. Used to detect the endgame boundary. */
export function totalMaterial(board: Board): number {
  let total = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell || cell.type === 'k') continue;
      total += PIECE_VALUE[cell.type];
    }
  }
  return total;
}
