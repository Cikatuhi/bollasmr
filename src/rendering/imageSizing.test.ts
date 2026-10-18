import { describe, expect, it } from 'vitest'
import { getImageScaleFactor } from './imageSizing'

describe('image sizing', () => {
  it('fits the longest image side to the physics diameter without distorting its aspect ratio', () => {
    const scale = getImageScaleFactor(32, 1000, 500)
    const width = 1000 * scale
    const height = 500 * scale

    expect(Math.max(width, height)).toBe(64)
    expect(width / height).toBe(2)
  })

  it('applies animation as a multiplier on top of the fitted image size', () => {
    const baseScale = getImageScaleFactor(24, 600, 900)
    const animatedScale = getImageScaleFactor(24, 600, 900, 1.2)

    expect(baseScale * 900).toBe(48)
    expect(animatedScale * 900).toBeCloseTo(57.6)
    expect(animatedScale / baseScale).toBeCloseTo(1.2)
  })

  it('safely handles empty or invalid texture dimensions', () => {
    expect(getImageScaleFactor(20, 0, Number.NaN)).toBe(40)
  })
})
