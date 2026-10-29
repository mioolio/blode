export interface PeerRangeRect {
  top: number;
  height: number;
  documentTop: number;
}

/** Clip projected document coordinates so a distant reader never paints outside the editor. */
export function clipPeerRange(
  documentTop: number,
  documentBottom: number,
  scrollTop: number,
  viewportHeight: number,
): PeerRangeRect | null {
  if (![documentTop, documentBottom, scrollTop, viewportHeight].every(Number.isFinite)) return null;
  if (viewportHeight <= 0 || documentBottom <= documentTop) return null;
  const top = Math.max(0, documentTop - scrollTop);
  const bottom = Math.min(viewportHeight, documentBottom - scrollTop);
  if (bottom <= top) return null;
  return { top, height: bottom - top, documentTop };
}

export type PeerRangeMotion = 'immediate' | 'move' | 'crossfade';

/** Local viewport motion must track exactly; only changes from the other reader are animated. */
export function peerRangeMotion(
  previous: PeerRangeRect | undefined,
  next: PeerRangeRect,
  viewportHeight: number,
  remoteChange: boolean,
  reducedMotion: boolean,
): PeerRangeMotion {
  if (!remoteChange || reducedMotion || !previous) return 'immediate';
  return Math.abs(next.documentTop - previous.documentTop) >= Math.max(1, viewportHeight)
    ? 'crossfade'
    : 'move';
}
