import type { Color, EngineMoveResult, PieceType } from '../chess/ChessEngine';
import type { MoveRecord, PieceId } from './types';
import { pieceIdFor } from './pieceId';

const BACK_RANK_TYPES: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

interface StartingPiece {
  square: string;
  color: Color;
  type: PieceType;
}

function standardStartingPieces(): StartingPiece[] {
  const pieces: StartingPiece[] = [];
  FILES.forEach((file, i) => {
    const backType = BACK_RANK_TYPES[i];
    if (!backType) throw new Error('unreachable: BACK_RANK_TYPES has 8 entries for 8 files');
    pieces.push({ square: `${file}1`, color: 'w', type: backType });
    pieces.push({ square: `${file}2`, color: 'w', type: 'p' });
    pieces.push({ square: `${file}7`, color: 'b', type: 'p' });
    pieces.push({ square: `${file}8`, color: 'b', type: backType });
  });
  return pieces;
}

function startingOccupancy(): Map<string, PieceId> {
  const occ = new Map<string, PieceId>();
  for (const p of standardStartingPieces()) {
    occ.set(p.square, pieceIdFor(p.color, p.type, p.square));
  }
  return occ;
}

/** The 32 PieceIds that exist at the start of any standard-start game. */
export const STANDARD_STARTING_PIECE_IDS: readonly PieceId[] = standardStartingPieces().map((p) =>
  pieceIdFor(p.color, p.type, p.square)
);

/**
 * Replays a sequence of engine moves (as produced by ChessEngine.loadPgn,
 * always starting from the standard position) and assigns every move a
 * stable PieceId for the piece that moved, the piece that was captured
 * (if any), and — for castling — the paired rook's PieceId/from/to.
 *
 * This is the only place PieceIds are minted. Everything downstream
 * (timeline beats, animation lanes) treats them as opaque stable keys.
 * Throws if the move list is internally inconsistent (e.g. references a
 * square with no tracked occupant) — that indicates a bug in this
 * function or in the upstream engine, not a recoverable user-facing
 * condition, so it is not modeled as a Result here.
 */
export function assignPieceIdentities(engineMoves: EngineMoveResult[]): MoveRecord[] {
  const occ = startingOccupancy();
  const records: MoveRecord[] = [];

  engineMoves.forEach((m, index) => {
    const ply = index + 1;
    const pieceId = occ.get(m.from);
    if (!pieceId) {
      throw new Error(`assignPieceIdentities: no tracked piece on ${m.from} at ply ${ply} (${m.san})`);
    }

    let capturedPieceId: PieceId | undefined;
    if (m.isCapture) {
      const capturedSquare = m.isEnPassant ? m.to.charAt(0) + m.from.charAt(1) : m.to;
      const capId = occ.get(capturedSquare);
      if (!capId) {
        throw new Error(
          `assignPieceIdentities: expected a captured piece on ${capturedSquare} at ply ${ply} (${m.san})`
        );
      }
      capturedPieceId = capId;
      occ.delete(capturedSquare);
    }

    occ.delete(m.from);
    occ.set(m.to, pieceId);

    let castle: 'king' | 'queen' | undefined;
    let rookMove: MoveRecord['rookMove'];
    if (m.isKingsideCastle || m.isQueensideCastle) {
      castle = m.isKingsideCastle ? 'king' : 'queen';
      const rank = m.color === 'w' ? '1' : '8';
      const rookFrom = (m.isKingsideCastle ? 'h' : 'a') + rank;
      const rookTo = (m.isKingsideCastle ? 'f' : 'd') + rank;
      const rookId = occ.get(rookFrom);
      if (!rookId) {
        throw new Error(
          `assignPieceIdentities: expected a rook on ${rookFrom} for castling at ply ${ply} (${m.san})`
        );
      }
      occ.delete(rookFrom);
      occ.set(rookTo, rookId);
      rookMove = { pieceId: rookId, from: rookFrom, to: rookTo };
    }

    records.push({
      ply,
      san: m.san,
      from: m.from,
      to: m.to,
      color: m.color,
      pieceType: m.piece,
      pieceId,
      capturedPieceId,
      promotion: m.promotion,
      isEnPassant: m.isEnPassant,
      castle,
      rookMove
    });
  });

  return records;
}
