/**
 * Uniform Pixi scale that fits an image inside the circular physics diameter.
 * Keeping this as a multiplier (instead of writing Sprite.width/height) lets
 * presentation effects scale the image without losing its base dimensions.
 */
export function getImageScaleFactor(radius: number, textureWidth: number, textureHeight: number, animationScale = 1) {
  const diameter = Math.max(1, Number.isFinite(radius) ? radius * 2 : 1)
  const width = Math.max(1, Number.isFinite(textureWidth) ? textureWidth : 1)
  const height = Math.max(1, Number.isFinite(textureHeight) ? textureHeight : 1)
  const effectScale = Math.max(0, Number.isFinite(animationScale) ? animationScale : 1)
  return (diameter / Math.max(width, height)) * effectScale
}
