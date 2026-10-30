export interface ImageViewport {
  width: number;
  height: number;
}
export interface ImagePoint {
  x: number;
  y: number;
}

export function fittedImageScale(image: ImageViewport, viewport: ImageViewport) {
  return Math.max(
    0.01,
    Math.min(
      1,
      Math.max(1, viewport.width - 32) / image.width,
      Math.max(1, viewport.height - 32) / image.height,
    ),
  );
}

/** Keep the image coordinate under the pointer unchanged when zooming. */
export function anchoredImageZoom(scale: number, next: number, pan: ImagePoint, anchor: ImagePoint) {
  const zoom = Math.max(0.01, Math.min(8, next));
  const ratio = zoom / scale;
  return {
    scale: zoom,
    pan: { x: anchor.x - (anchor.x - pan.x) * ratio, y: anchor.y - (anchor.y - pan.y) * ratio },
  };
}
