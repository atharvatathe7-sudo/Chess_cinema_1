/** The subset of Canvas 2D drawing capability the renderer needs — satisfied identically by
 * an on-screen CanvasRenderingContext2D (preview) and an OffscreenCanvasRenderingContext2D
 * (export), so the same drawing functions work unmodified against either. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
