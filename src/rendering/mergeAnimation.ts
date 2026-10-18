export const MERGE_ANIMATION_MS = 520

/** Smoothly fades a merge burst while its ring expands. */
export function getMergeAnimationProgress(elapsedMs: number) {
  return Math.max(0, Math.min(1, elapsedMs / MERGE_ANIMATION_MS))
}

/** Scale multiplier for the newly-created level object. */
export function getMergePopScale(progress: number) {
  const t = Math.max(0, Math.min(1, progress))
  // A short overshoot makes the result feel like it has weight without
  // moving or modifying its Matter.js body.
  const settle = 0.55 + 0.45 * (1 - (1 - t) ** 3)
  return settle + Math.sin(t * Math.PI) * (1 - t) * 0.2
}
