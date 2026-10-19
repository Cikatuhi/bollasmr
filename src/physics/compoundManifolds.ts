import Matter from 'matter-js'

type Collision = ReturnType<typeof Matter.Detector.collisions>[number]

/**
 * Matter detects a separate collision for every pair of convex fixtures in a
 * compound PNG. Those fixtures describe one image, not several independent
 * objects; resolving every overlapping fixture pair can apply competing
 * normals and lever arms to the same touch. Keep the deepest manifold for an
 * image/image or image/object pair so one visual contact produces one impulse.
 */
export function coalesceCompoundManifolds(collisions: Collision[]) {
  const contactsByPair = new Map<string, Collision[]>()

  for (const collision of collisions) {
    const parentA = collision.parentA
    const parentB = collision.parentB
    if (parentA === parentB || (parentA.parts.length <= 1 && parentB.parts.length <= 1)) continue

    const key = parentA.id < parentB.id
      ? `${parentA.id}:${parentB.id}`
      : `${parentB.id}:${parentA.id}`
    const contacts = contactsByPair.get(key) ?? []
    contacts.push(collision)
    contactsByPair.set(key, contacts)
  }

  if (contactsByPair.size === 0) return collisions

  const kept = new Set<Collision>()
  for (const contacts of contactsByPair.values()) {
    // Adjacent alpha-mask tiles can report several slightly different normals
    // for one local touch. Keep the deepest contact in that small region, but
    // retain contacts on distant lobes so concave and multi-pronged images
    // still have independent constraints and can rotate naturally.
    const candidates = [...contacts].sort((a, b) => b.depth - a.depth)
    const clusters: Array<{ collisions: Collision[]; x: number; y: number }> = []
    for (const collision of candidates) {
      const supportCount = (collision as Collision & { supportCount?: number }).supportCount ?? collision.supports.length
      const supports = collision.supports.slice(0, supportCount)
      const contactX = supports.length > 0
        ? supports.reduce((sum, support) => sum + support.x, 0) / supports.length
        : (collision.bodyA.position.x + collision.bodyB.position.x) / 2
      const contactY = supports.length > 0
        ? supports.reduce((sum, support) => sum + support.y, 0) / supports.length
        : (collision.bodyA.position.y + collision.bodyB.position.y) / 2
      const minExtent = Math.min(
        collision.parentA.bounds.max.x - collision.parentA.bounds.min.x,
        collision.parentA.bounds.max.y - collision.parentA.bounds.min.y,
        collision.parentB.bounds.max.x - collision.parentB.bounds.min.x,
        collision.parentB.bounds.max.y - collision.parentB.bounds.min.y,
      )
      // Adjacent alpha-mask tiles are one visual touch, even if the rectangular
      // fixtures report slightly different support points. Keep the deepest
      // real Matter manifold; never synthesize or average a new normal.
      const localTouchRadius = Math.max(4, Math.min(14, minExtent * 0.25))
      const localCluster = clusters.find((cluster) =>
        Math.hypot(cluster.x - contactX, cluster.y - contactY) <= localTouchRadius)
      if (localCluster) {
        localCluster.collisions.push(collision)
        continue
      }
      clusters.push({ collisions: [collision], x: contactX, y: contactY })
    }

    for (const cluster of clusters) {
      const representative = cluster.collisions[0]!
      kept.add(representative)
      if (cluster.collisions.length < 2) continue

    }
  }

  return collisions.filter((collision) => {
    const parentA = collision.parentA
    const parentB = collision.parentB
    const isCompoundPair = parentA !== parentB && (parentA.parts.length > 1 || parentB.parts.length > 1)
    return !isCompoundPair || kept.has(collision)
  })
}

const activeDetectors = new Set<Matter.Detector>()
let originalCollisions: typeof Matter.Detector.collisions | undefined
let wrappedCollisions: typeof Matter.Detector.collisions | undefined

/** Install the filter only for BallPlay engines and restore Matter on teardown. */
export function registerCompoundManifoldFilter(detector: Matter.Detector) {
  activeDetectors.add(detector)
  if (!wrappedCollisions) {
    originalCollisions = Matter.Detector.collisions
    wrappedCollisions = (candidate) => {
      const collisions = originalCollisions!(candidate)
      return activeDetectors.has(candidate) ? coalesceCompoundManifolds(collisions) : collisions
    }
    Matter.Detector.collisions = wrappedCollisions
  }

  let released = false
  return () => {
    if (released) return
    released = true
    activeDetectors.delete(detector)
    if (activeDetectors.size === 0 && wrappedCollisions && Matter.Detector.collisions === wrappedCollisions) {
      Matter.Detector.collisions = originalCollisions!
      originalCollisions = undefined
      wrappedCollisions = undefined
    }
  }
}
