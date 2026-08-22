import type { Color, PieceType } from '../chess/ChessEngine';
import type { PieceId } from './types';

/**
 * PieceId encoding: "{color}-{startingType}-{startingSquare}", e.g.
 * "w-p-e2", "b-n-g8". Stable for the life of a GameRecord — a piece
 * keeps this id even through promotion (which changes displayed type,
 * not identity). This is the single place the string format is defined;
 * both assignPieceIdentities (encode) and timeline/invariants (decode)
 * go through these two functions rather than re-deriving the format.
 */
export function pieceIdFor(color: Color, startingType: PieceType, startingSquare: string): PieceId {
  return `${color}-${startingType}-${startingSquare}`;
}

export function parsePieceId(id: PieceId): { color: Color; startingType: PieceType; startingSquare: string } {
  const [color, startingType, startingSquare] = id.split('-');
  if (!color || !startingType || !startingSquare) {
    throw new Error(`parsePieceId: malformed PieceId "${id}"`);
  }
  return { color: color as Color, startingType: startingType as PieceType, startingSquare };
}
