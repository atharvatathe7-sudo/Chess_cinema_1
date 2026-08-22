import { Chess } from 'chess.js';
import type { Color, PieceType } from '../chess/ChessEngine';
import type { PlyAnalysis } from '../analysis/types';
import type { ThreatRecord } from './types';
import { attackersOf, boardFromFen, coordsOf, squareName, staticExchangeEvaluation, type Board } from './geometry';

/**
 * SEE-gated threat model. A geometric attack is only ever materialized as a
 * ThreatRecord if it clears one of the gates below — trivial attacks on
 * adequately defended, low-value pieces never produce a record at all.
 * Everything here is chess-rule evidence; nothing in this module calls the
 * analysis engine.
 */

function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/** Swaps side-to-move for a one-ply lookahead without altering the board, clearing en passant (only valid for the actual mover). */
function withSideToMove(fen: string, color: Color): string {
  const parts = fen.split(' ');
  parts[1] = color;
  parts[3] = '-';
  return parts.join(' ');
}

export interface RawThreat {
  readonly kind: ThreatRecord['kind'];
  readonly targetSquare: string;
  readonly targetPiece?: PieceType;
  readonly netMaterialIfExecuted?: number;
  readonly basis: 'chess-rule' | 'inference';
  readonly confidence?: number;
  readonly note: string;
}

/**
 * Categorically forcing regardless of piece values, so no SEE gate applies.
 * Detected via chess.js's own legal-move generation after a one-ply
 * side-to-move flip (a standard "null move" technique) — a candidate move
 * is a real check threat only if chess.js's own move list actually
 * confirms it delivers check. Mate-in-1 is confirmed the same way and, as
 * a fully rule-verifiable case, is reported as chess-rule evidence rather
 * than spending engine budget on it — see the Phase 2.2 completion report
 * for why this is a deliberate, disclosed deviation from "mate-threat
 * confirmed by the engine."
 */
export function findCheckAndMateThreats(fen: string, attackerColor: Color): RawThreat[] {
  let chess: Chess;
  try {
    chess = new Chess(withSideToMove(fen, attackerColor));
  } catch {
    return [];
  }
  const moves = chess.moves({ verbose: true }) as ReadonlyArray<{ san: string; to: string }>;
  const results: RawThreat[] = [];
  for (const move of moves) {
    if (move.san.includes('#')) {
      results.push({
        kind: 'mate-threat',
        targetSquare: move.to,
        basis: 'chess-rule',
        note: `mate-in-1 confirmed by chess.js: ${move.san}`
      });
    } else if (move.san.includes('+')) {
      results.push({
        kind: 'check-threat',
        targetSquare: move.to,
        basis: 'chess-rule',
        note: `check confirmed by chess.js: ${move.san}`
      });
    }
  }
  return results;
}

/** SEE > 0 for the attacker — a genuine net material gain after best defense, not merely "attacks a piece". */
export function findMaterialWinningThreats(board: Board, attackerColor: Color): RawThreat[] {
  const defenderColor = opposite(attackerColor);
  const results: RawThreat[] = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r]?.[f];
      if (!piece || piece.color !== defenderColor) continue;
      const see = staticExchangeEvaluation(board, { r, f }, attackerColor);
      if (see > 0) {
        results.push({
          kind: 'material-winning-threat',
          targetSquare: squareName(f, r),
          targetPiece: piece.type,
          netMaterialIfExecuted: see,
          basis: 'chess-rule',
          note: `SEE(${squareName(f, r)}) = ${see} for the attacker`
        });
      }
    }
  }
  return results;
}

/** A non-king enemy piece that is both attacked and has zero legal squares to retreat to. Always inferred, stricter bar. */
export function findPositionalRestrictionThreats(fen: string, attackerColor: Color): RawThreat[] {
  const defenderColor = opposite(attackerColor);
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return [];
  }
  if (chess.turn() !== defenderColor) return [];
  const board = boardFromFen(fen);
  const results: RawThreat[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== defenderColor || cell.type === 'k') continue;
      const attackers = attackersOf(board, coordsOf(cell.square), attackerColor);
      if (attackers.length === 0) continue;
      const legalMoves = chess.moves({ square: cell.square as never, verbose: true }) as ReadonlyArray<unknown>;
      if (legalMoves.length === 0) {
        results.push({
          kind: 'positional-restriction-threat',
          targetSquare: cell.square,
          targetPiece: cell.type as PieceType,
          basis: 'inference',
          confidence: 0.6,
          note: `${cell.square} is attacked and has zero legal squares`
        });
      }
    }
  }
  return results;
}

function nextIdFactory(ply: number): () => string {
  let counter = 0;
  return () => `threat-${ply}-${counter++}`;
}

/** Raw threats for one ply, from the position the mover just reached (fenAfter), attributed to the mover's own following move. */
export function detectThreatsForPly(ply: PlyAnalysis): ThreatRecord[] {
  const board = boardFromFen(ply.fenAfter);
  const attackerColor = ply.sideToMove;
  const raw = [
    ...findCheckAndMateThreats(ply.fenAfter, attackerColor),
    ...findMaterialWinningThreats(board, attackerColor),
    ...findPositionalRestrictionThreats(ply.fenAfter, attackerColor)
  ];
  const nextId = nextIdFactory(ply.ply);
  return raw.map((r) => ({
    id: nextId(),
    ply: ply.ply,
    side: attackerColor,
    kind: r.kind,
    targetSquare: r.targetSquare,
    ...(r.targetPiece !== undefined ? { targetPiece: r.targetPiece } : {}),
    ...(r.netMaterialIfExecuted !== undefined ? { netMaterialIfExecuted: r.netMaterialIfExecuted } : {}),
    evidence: {
      basis: r.basis,
      ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
      sourcePlies: [ply.ply],
      note: r.note
    }
  }));
}

/**
 * Detects a threat's counter, by checking whether the very next ply (the
 * opponent's actual reply) moved the threatened piece away or captured on
 * the threatened square — a direct, deterministic read of the already-
 * computed move list, not a new search.
 */
export function attachRefutations(threats: readonly ThreatRecord[], plies: readonly PlyAnalysis[]): ThreatRecord[] {
  const byPly = new Map<number, PlyAnalysis>();
  for (const p of plies) byPly.set(p.ply, p);

  return threats.map((threat) => {
    const reply = byPly.get(threat.ply + 1);
    if (!reply) return threat;
    const from = reply.movePlayedUci.slice(0, 2);
    const to = reply.movePlayedUci.slice(2, 4);
    if (from === threat.targetSquare || to === threat.targetSquare) {
      return { ...threat, refutedBy: { ply: reply.ply, moveUci: reply.movePlayedUci } };
    }
    return threat;
  });
}

export function detectThreats(plies: readonly PlyAnalysis[]): ThreatRecord[] {
  const raw = plies.flatMap((ply) => detectThreatsForPly(ply));
  return attachRefutations(raw, plies);
}
