/**
 * Compact, resolution-independent collision geometry for a PNG object.
 * Coordinates use the longest image dimension as one unit and are relative
 * to the centre of the original image frame. Each part is a convex rectangle,
 * so Matter.js can build a compound body without an optional decomposition lib.
 */
export type ImageCollisionPoint = { x: number; y: number }
export type ImageCollisionEdge = { from: ImageCollisionPoint; to: ImageCollisionPoint }

export type ImageCollisionGeometry = {
  version: 1
  sourceWidth: number
  sourceHeight: number
  /** Convex rectangles describing occupied alpha-mask cells. */
  parts: ImageCollisionPoint[][]
  /** Area-weighted centre of the shape relative to the PNG frame centre. */
  centroid: ImageCollisionPoint
}

const ALPHA_THRESHOLD = 36
const MAX_GRID_SIZE = 48
/**
 * Keep silhouettes smooth enough that one light touch does not hit a coarse
 * staircase, while bounding fixture cost in crowded scenes. Compound contact
 * manifolds are coalesced by the physics layer before Matter resolves them.
 */
export const MAX_COLLISION_PARTS = 16
/** Older saved records can still be loaded and regenerated from their PNG. */
const MAX_STORED_PARTS = 96
const GRID_FALLBACK_SIZES = [48, 40, 32, 24, 16, 12, 11, 10, 9, 8, 4, 2, 1]

type Rectangle = { left: number; top: number; right: number; bottom: number }

function spansForRow(mask: Uint8Array, width: number, y: number) {
  const spans: Array<[number, number]> = []
  let start = -1
  for (let x = 0; x <= width; x += 1) {
    const opaque = x < width && mask[y * width + x]! > 0
    if (opaque && start < 0) start = x
    if (!opaque && start >= 0) {
      spans.push([start, x])
      start = -1
    }
  }
  return spans
}

/** Merge identical occupied runs on adjacent rows into a small set of rectangles. */
function rectanglesFromMask(mask: Uint8Array, width: number, height: number): Rectangle[] {
  const finished: Rectangle[] = []
  let active = new Map<string, Rectangle>()

  for (let y = 0; y < height; y += 1) {
    const next = new Map<string, Rectangle>()
    for (const [left, right] of spansForRow(mask, width, y)) {
      const key = `${left}:${right}`
      const existing = active.get(key)
      next.set(key, existing ? { ...existing, bottom: y + 1 } : { left, right, top: y, bottom: y + 1 })
    }
    for (const [key, rectangle] of active) if (!next.has(key)) finished.push(rectangle)
    active = next
  }
  finished.push(...active.values())
  return finished
}

function downsampleMask(mask: Uint8Array, width: number, height: number, targetWidth: number, targetHeight: number) {
  const output = new Uint8Array(targetWidth * targetHeight)
  for (let y = 0; y < targetHeight; y += 1) {
    const top = Math.floor(y * height / targetHeight)
    const bottom = Math.max(top + 1, Math.ceil((y + 1) * height / targetHeight))
    for (let x = 0; x < targetWidth; x += 1) {
      const left = Math.floor(x * width / targetWidth)
      const right = Math.max(left + 1, Math.ceil((x + 1) * width / targetWidth))
      let opaque = false
      for (let sy = top; sy < Math.min(height, bottom) && !opaque; sy += 1) {
        for (let sx = left; sx < Math.min(width, right); sx += 1) {
          if (mask[sy * width + sx]! > 0) { opaque = true; break }
        }
      }
      if (opaque) output[y * targetWidth + x] = 1
    }
  }
  return output
}

/**
 * Convert alpha pixels into a bounded set of convex parts. This pure helper is
 * also used in tests; browser decoding/canvas access lives below it.
 */
export function imageCollisionGeometryFromAlpha(
  sourceWidth: number,
  sourceHeight: number,
  maskWidth: number,
  maskHeight: number,
  alpha: Uint8Array,
): ImageCollisionGeometry {
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 ||
      !Number.isInteger(maskWidth) || !Number.isInteger(maskHeight) || maskWidth < 1 || maskHeight < 1 ||
      alpha.length !== maskWidth * maskHeight) {
    throw new Error('Некорректные размеры alpha-маски PNG.')
  }

  const opaque = new Uint8Array(alpha.length)
  let hasVisiblePixel = false
  for (let index = 0; index < alpha.length; index += 1) {
    opaque[index] = alpha[index]! >= ALPHA_THRESHOLD ? 1 : 0
    hasVisiblePixel ||= opaque[index] === 1
  }
  if (!hasVisiblePixel) throw new Error('PNG полностью прозрачный — нечего добавить в сцену.')

  let rectangles: Rectangle[] = []
  let selectedWidth = maskWidth
  let selectedHeight = maskHeight
  const maxSize = Math.min(MAX_GRID_SIZE, Math.max(maskWidth, maskHeight))
  const attempts = GRID_FALLBACK_SIZES.filter((size) => size <= maxSize)
  if (!attempts.includes(maxSize)) attempts.unshift(maxSize)
  for (const longest of attempts) {
    selectedWidth = Math.max(1, Math.round(maskWidth * longest / Math.max(maskWidth, maskHeight)))
    selectedHeight = Math.max(1, Math.round(maskHeight * longest / Math.max(maskWidth, maskHeight)))
    const sample = selectedWidth === maskWidth && selectedHeight === maskHeight
      ? opaque
      : downsampleMask(opaque, maskWidth, maskHeight, selectedWidth, selectedHeight)
    rectangles = rectanglesFromMask(sample, selectedWidth, selectedHeight)
    if (rectangles.length <= MAX_COLLISION_PARTS) break
  }
  if (rectangles.length === 0) throw new Error('В PNG не найден видимый силуэт.')

  const longestSourceSide = Math.max(sourceWidth, sourceHeight)
  const normalizedWidth = sourceWidth / longestSourceSide
  const normalizedHeight = sourceHeight / longestSourceSide
  const toImagePoint = (x: number, y: number): ImageCollisionPoint => ({
    x: (x / selectedWidth - 0.5) * normalizedWidth,
    y: (y / selectedHeight - 0.5) * normalizedHeight,
  })

  let totalArea = 0
  let centroidX = 0
  let centroidY = 0
  const parts = rectangles.map((rectangle) => {
    const topLeft = toImagePoint(rectangle.left, rectangle.top)
    const topRight = toImagePoint(rectangle.right, rectangle.top)
    const bottomRight = toImagePoint(rectangle.right, rectangle.bottom)
    const bottomLeft = toImagePoint(rectangle.left, rectangle.bottom)
    const area = (topRight.x - topLeft.x) * (bottomLeft.y - topLeft.y)
    const centerX = (topLeft.x + bottomRight.x) / 2
    const centerY = (topLeft.y + bottomRight.y) / 2
    totalArea += area
    centroidX += centerX * area
    centroidY += centerY * area
    return [topLeft, topRight, bottomRight, bottomLeft]
  })

  if (totalArea <= 0) throw new Error('Не удалось построить физическую форму PNG.')
  return {
    version: 1,
    sourceWidth,
    sourceHeight,
    parts,
    centroid: { x: centroidX / totalArea, y: centroidY / totalArea },
  }
}

/** Decode a PNG and derive collision geometry from its transparency. */
export async function createImageCollisionGeometry(blob: Blob): Promise<ImageCollisionGeometry> {
  let source: CanvasImageSource
  let cleanup = () => {}

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    source = bitmap
    cleanup = () => bitmap.close()
  } else {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    try {
      await image.decode()
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
    source = image
    cleanup = () => { image.src = ''; URL.revokeObjectURL(url) }
  }

  try {
    const sourceWidth = 'naturalWidth' in source ? source.naturalWidth : source.width
    const sourceHeight = 'naturalHeight' in source ? source.naturalHeight : source.height
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('PNG не содержит декодируемого изображения.')
    const scale = Math.min(1, MAX_GRID_SIZE / Math.max(sourceWidth, sourceHeight))
    const maskWidth = Math.max(1, Math.round(sourceWidth * scale))
    const maskHeight = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = maskWidth
    canvas.height = maskHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Браузер не смог подготовить PNG для физической оболочки.')
    context.clearRect(0, 0, maskWidth, maskHeight)
    context.imageSmoothingEnabled = true
    context.drawImage(source, 0, 0, maskWidth, maskHeight)
    const rgba = context.getImageData(0, 0, maskWidth, maskHeight).data
    const alpha = new Uint8Array(maskWidth * maskHeight)
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3]!
    return imageCollisionGeometryFromAlpha(sourceWidth, sourceHeight, maskWidth, maskHeight, alpha)
  } finally {
    cleanup()
  }
}

export function isImageCollisionGeometry(value: unknown): value is ImageCollisionGeometry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ImageCollisionGeometry>
  if (candidate.version !== 1 || !Number.isInteger(candidate.sourceWidth) || (candidate.sourceWidth ?? 0) < 1 ||
      !Number.isInteger(candidate.sourceHeight) || (candidate.sourceHeight ?? 0) < 1 ||
      !Array.isArray(candidate.parts) || candidate.parts.length < 1 || candidate.parts.length > MAX_STORED_PARTS ||
      !candidate.centroid || !Number.isFinite(candidate.centroid.x) || !Number.isFinite(candidate.centroid.y)) return false
  return candidate.parts.every((part) => Array.isArray(part) && part.length === 4 && part.every((point) =>
    typeof point === 'object' && point !== null && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Math.abs(point.x) <= 0.51 && Math.abs(point.y) <= 0.51))
}

export function getImageCollisionRadius(geometry: ImageCollisionGeometry | undefined, radius: number) {
  if (!geometry) return radius
  const diameter = Math.max(0, radius * 2)
  let maxDistance = 0
  for (const part of geometry.parts) for (const point of part) {
    maxDistance = Math.max(maxDistance, Math.hypot(point.x - geometry.centroid.x, point.y - geometry.centroid.y))
  }
  return maxDistance * diameter
}

/** Return only the external edges of the alpha-mask tiles, in body-centred pixels. */
export function getImageCollisionOutline(geometry: ImageCollisionGeometry, diameter: number): ImageCollisionEdge[] {
  const scale = Number.isFinite(diameter) ? Math.max(0, diameter) : 0
  const groups = new Map<string, { coordinate: number; intervals: Array<[number, number]>; horizontal: boolean }>()
  const lineKey = (axis: 'h' | 'v', coordinate: number) => `${axis}:${coordinate.toFixed(6)}`

  for (const part of geometry.parts) {
    const points = part.map((point) => ({
      x: (point.x - geometry.centroid.x) * scale,
      y: (point.y - geometry.centroid.y) * scale,
    }))
    for (let index = 0; index < points.length; index += 1) {
      const from = points[index]!
      const to = points[(index + 1) % points.length]!
      const horizontal = Math.abs(from.y - to.y) < 0.000001
      const coordinate = horizontal ? from.y : from.x
      const key = lineKey(horizontal ? 'h' : 'v', coordinate)
      let group = groups.get(key)
      if (!group) {
        group = { coordinate, intervals: [], horizontal }
        groups.set(key, group)
      }
      group.intervals.push(horizontal
        ? [Math.min(from.x, to.x), Math.max(from.x, to.x)]
        : [Math.min(from.y, to.y), Math.max(from.y, to.y)])
    }
  }

  const outline: ImageCollisionEdge[] = []
  for (const group of groups.values()) {
    const breakpoints = [...new Set(group.intervals.flat().map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b)
    let pending: [number, number] | undefined
    for (let index = 1; index < breakpoints.length; index += 1) {
      const start = breakpoints[index - 1]!
      const end = breakpoints[index]!
      if (end - start < 0.000001) continue
      const middle = (start + end) / 2
      const edgeCount = group.intervals.filter(([from, to]) => from < middle && to > middle).length
      if (edgeCount === 1) {
        if (pending && Math.abs(pending[1] - start) < 0.000001) pending[1] = end
        else {
          if (pending) outline.push(makeOutlineEdge(group, pending))
          pending = [start, end]
        }
      } else if (pending) {
        outline.push(makeOutlineEdge(group, pending))
        pending = undefined
      }
    }
    if (pending) outline.push(makeOutlineEdge(group, pending))
  }
  return outline
}

function makeOutlineEdge(group: { coordinate: number; horizontal: boolean }, interval: [number, number]): ImageCollisionEdge {
  return group.horizontal
    ? { from: { x: interval[0], y: group.coordinate }, to: { x: interval[1], y: group.coordinate } }
    : { from: { x: group.coordinate, y: interval[0] }, to: { x: group.coordinate, y: interval[1] } }
}
