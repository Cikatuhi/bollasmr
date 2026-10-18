export type ArenaPoint = { x: number; y: number }

/** Shared geometry for the vertical merge arena. Coordinates are in scene units. */
export const ARENA_CENTER = { x: 180, y: 310 }
export const ARENA_RADIUS = 160
export const ARENA_NECK = { left: 130, right: 230, top: -18, shoulderY: 104 }

const lerp = (a: ArenaPoint, b: ArenaPoint, t: number): ArenaPoint => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

const cubic = (a: ArenaPoint, b: ArenaPoint, c: ArenaPoint, d: ArenaPoint, t: number): ArenaPoint => {
  const ab = lerp(a, b, t)
  const bc = lerp(b, c, t)
  const cd = lerp(c, d, t)
  return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t)
}

/**
 * Open path used by both Matter and Pixi. It starts at the top of the left
 * chute, follows the left shoulder and the lower circular bowl, then exits
 * through the right chute. There is intentionally no top cap: objects enter
 * the arena from above.
 */
export function createArenaPath(): ArenaPoint[] {
  const points: ArenaPoint[] = [{ x: ARENA_NECK.left, y: ARENA_NECK.top }, { x: ARENA_NECK.left, y: ARENA_NECK.shoulderY }]
  const leftStart = points[points.length - 1]!
  const leftEnd = {
    x: ARENA_CENTER.x + Math.cos((-146 * Math.PI) / 180) * ARENA_RADIUS,
    y: ARENA_CENTER.y + Math.sin((-146 * Math.PI) / 180) * ARENA_RADIUS,
  }
  for (let i = 1; i <= 10; i += 1) {
    points.push(cubic(leftStart, { x: 110, y: 111 }, { x: 58, y: 145 }, leftEnd, i / 10))
  }

  // Clockwise in screen coordinates, through the bottom of the bowl.
  for (let i = 1; i <= 44; i += 1) {
    const angle = (-146 - (244 * i) / 44) * (Math.PI / 180)
    points.push({
      x: ARENA_CENTER.x + Math.cos(angle) * ARENA_RADIUS,
      y: ARENA_CENTER.y + Math.sin(angle) * ARENA_RADIUS,
    })
  }

  const rightStart = points[points.length - 1]!
  const rightEnd = { x: ARENA_NECK.right, y: ARENA_NECK.shoulderY }
  for (let i = 1; i <= 10; i += 1) {
    points.push(cubic(rightStart, { x: 302, y: 145 }, { x: 250, y: 111 }, rightEnd, i / 10))
  }
  points.push({ x: ARENA_NECK.right, y: ARENA_NECK.top })
  return points
}

export const arenaPath = createArenaPath()

export function arenaColorAt(progress: number): number {
  const stops = [
    [0x2bd8e8, 0], [0x9cf33e, 0.08], [0xff3d9a, 0.23], [0x755bff, 0.4],
    [0x19c9ff, 0.53], [0x40ee75, 0.67], [0xf9f53f, 0.78], [0xff9838, 0.86],
    [0xd447ff, 0.94], [0x35d9ff, 1],
  ] as const
  const clamped = Math.max(0, Math.min(1, progress))
  for (let index = 1; index < stops.length; index += 1) {
    const [rightColor, rightAt] = stops[index]!
    const [leftColor, leftAt] = stops[index - 1]!
    if (clamped <= rightAt) {
      const t = (clamped - leftAt) / (rightAt - leftAt)
      const channel = (shift: number) => Math.round((((leftColor >> shift) & 0xff) * (1 - t)) + (((rightColor >> shift) & 0xff) * t))
      return (channel(16) << 16) | (channel(8) << 8) | channel(0)
    }
  }
  return stops[stops.length - 1]![0]
}
