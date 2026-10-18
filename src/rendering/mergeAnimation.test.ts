import { describe, expect, it } from 'vitest'
import { getMergeAnimationProgress, getMergePopScale, MERGE_ANIMATION_MS } from './mergeAnimation'

describe('merge presentation animation', () => {
  it('clamps elapsed time to the burst animation range', () => {
    expect(getMergeAnimationProgress(-10)).toBe(0)
    expect(getMergeAnimationProgress(MERGE_ANIMATION_MS / 2)).toBe(0.5)
    expect(getMergeAnimationProgress(MERGE_ANIMATION_MS * 2)).toBe(1)
  })

  it('gives a brief scale overshoot and settles back to the normal size', () => {
    expect(getMergePopScale(0)).toBeLessThan(1)
    expect(getMergePopScale(0.5)).toBeGreaterThan(1)
    expect(getMergePopScale(1)).toBe(1)
    expect(getMergePopScale(2)).toBe(1)
  })
})
