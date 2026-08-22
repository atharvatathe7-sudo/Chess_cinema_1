import type { Color, Piece, PieceType } from '../chess/ChessEngine';

/** square ('e4') -> Piece, for every occupied square in the FEN's placement field. */
export function parseFenPlacement(fen: string): Map<string, Piece> {
  const placement = fen.split(' ')[0];
  if (!placement) throw new Error(`parseFenPlacement: empty FEN "${fen}"`);
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error(`parseFenPlacement: malformed FEN placement "${placement}"`);

  const board = new Map<string, Piece>();
  ranks.forEach((rankStr, rankIndex) => {
    const rank = 8 - rankIndex;
    let file = 0;
    for (const ch of rankStr) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const color: Color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toLowerCase() as PieceType;
      const square = `${'abcdefgh'.charAt(file)}${rank}`;
      board.set(square, { type, color });
      file += 1;
    }
  });
  return board;
}

export function pieceAtSquare(fen: string, square: string): Piece | null {
  return parseFenPlacement(fen).get(square) ?? null;
}
