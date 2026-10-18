import { describe, expect, it } from 'vitest'
import { getImageCollisionOutline, imageCollisionGeometryFromAlpha, MAX_COLLISION_PARTS } from './imageCollisionGeometry'

function alphaMask(width: number, height: number, isOpaque: (x: number, y: number) => boolean) {
  const alpha = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) alpha[y * width + x] = isOpaque(x, y) ? 255 : 0
  }
  return alpha
}

describe('PNG collision geometry', () => {
  it('fits the visible alpha silhouette, including transparent holes', () => {
    const size = 12
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size,
      alphaMask(size, size, (x, y) => x < 3 || x >= 9 || y < 3 || y >= 9))

    expect(geometry.parts.length).toBeGreaterThan(1)
    expect(geometry.centroid.x).toBeCloseTo(0)
    expect(geometry.centroid.y).toBeCloseTo(0)
    expect(geometry.parts.flat().every((point) => Math.abs(point.x) <= 0.5 && Math.abs(point.y) <= 0.5)).toBe(true)
  })

  it('outlines the PNG silhouette without circular bounds or internal tile seams', () => {
    const size = 12
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size,
      alphaMask(size, size, (x, y) => x < 3 || x >= 9 || y < 3 || y >= 9))
    const outline = getImageCollisionOutline(geometry, 48)

    // Four outer sides plus four sides around the transparent hole. Internal
    // edges where the mask tiles meet must not appear in the selection ring.
    expect(outline).toHaveLength(8)
    expect(outline.every((edge) => edge.from.x === edge.to.x || edge.from.y === edge.to.y)).toBe(true)
  })

  it('keeps the PNG frame offset for an off-centre silhouette', () => {
    const width = 10
    const height = 8
    const geometry = imageCollisionGeometryFromAlpha(width, height, width, height,
      alphaMask(width, height, (x, y) => x <= 2 && y >= 2 && y <= 5))

    expect(geometry.centroid.x).toBeLessThan(-0.15)
    expect(geometry.centroid.y).toBeCloseTo(0)
  })

  it('rejects fully transparent uploads and malformed masks', () => {
    expect(() => imageCollisionGeometryFromAlpha(4, 4, 4, 4, new Uint8Array(16))).toThrow(/полностью прозрачный/)
    expect(() => imageCollisionGeometryFromAlpha(4, 4, 4, 4, new Uint8Array(15))).toThrow(/Некорректные размеры/)
  })

  it('keeps complex PNG silhouettes within a small compound-body fixture budget', () => {
    const size = 48
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size,
      alphaMask(size, size, (x, y) => [7, 18, 29, 40].some((centerX) => [7, 18, 29, 40].some((centerY) =>
        (x - centerX) ** 2 + (y - centerY) ** 2 <= 4 ** 2))))
    expect(geometry.parts.length).toBeGreaterThan(1)
    expect(geometry.parts.length).toBeLessThanOrEqual(MAX_COLLISION_PARTS)
    expect(geometry.parts.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) &&
      Math.abs(point.x) <= 0.5 && Math.abs(point.y) <= 0.5)).toBe(true)
    expect(Number.isFinite(geometry.centroid.x) && Number.isFinite(geometry.centroid.y)).toBe(true)
  })
})
