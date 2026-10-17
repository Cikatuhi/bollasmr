import type { ObjectDefinition } from '../objects/definitions'
import type { SceneObject } from './SimulationScene'

/** A stable identity for an object's merge progression. */
export type MergeIdentity = {
  collectionId: string
  level: number
}

export type MergePosition = { x: number; y: number }
export type MergeVelocity = { x: number; y: number }

export type MergeEvent = {
  first: SceneObject
  second: SceneObject
  result: SceneObject
  from: MergeIdentity
  to: MergeIdentity
  impact: number
  position: MergePosition
}

/**
 * Adapter used by MergeSystem to stay independent from React, Pixi and the
 * persistence layer. All mutations happen in flush(), after Matter has
 * finished its collision step.
 */
export type MergeSystemOptions = {
  /** Resolve collection + level from a scene object. */
  getIdentity?: (object: SceneObject) => MergeIdentity | undefined
  /** Resolve the next level definition. Return undefined for a terminal level. */
  getNextLevel: (identity: MergeIdentity, source: SceneObject) => {
    identity: MergeIdentity
    definition: ObjectDefinition
  } | undefined
  /** Remove an object from the scene and Matter world. */
  removeObject: (object: SceneObject) => void
  /** Create an object in the scene at the supplied position and velocity. */
  createObject: (definition: ObjectDefinition, position: MergePosition, velocity: MergeVelocity) => SceneObject | undefined
  /** Called once, only after the result body has been created successfully. */
  onMerged?: (event: MergeEvent) => void
  /** Safety valve for malformed or very busy collision streams. */
  maxPendingPairs?: number
  onError?: (error: unknown) => void
}

type PendingPair = { first: SceneObject; second: SceneObject; impact: number }

const defaultIdentity = (object: SceneObject): MergeIdentity | undefined => {
  // Keep the core ObjectDefinition backwards-compatible. User collections can
  // expose either the explicit merge fields or the shorter aliases.
  const definition = object.definition as ObjectDefinition & {
    collectionId?: unknown
    level?: unknown
    mergeCollectionId?: unknown
    mergeLevel?: unknown
  }
  const collectionId = typeof definition.collectionId === 'string'
    ? definition.collectionId
    : typeof definition.mergeCollectionId === 'string' ? definition.mergeCollectionId : undefined
  const rawLevel = definition.level ?? definition.mergeLevel
  const level = typeof rawLevel === 'number' && Number.isInteger(rawLevel) ? rawLevel : undefined
  if (!collectionId || level === undefined || level < 1) return undefined
  return { collectionId, level }
}

/**
 * Deferred, duplicate-safe merge coordinator for Matter scene objects.
 *
 * Collision handlers should call enqueue() only. Call flush() immediately
 * after Engine.update (for example at the end of SimulationScene.step()).
 * This guarantees that bodies are never removed while Matter is iterating its
 * collision pairs.
 */
export class MergeSystem {
  private readonly options: MergeSystemOptions
  private readonly pending = new Map<string, PendingPair>()

  constructor(options: MergeSystemOptions) {
    this.options = options
  }

  get pendingCount() { return this.pending.size }

  /** Returns true when both objects belong to the same merge collection/level. */
  isCandidate(first: SceneObject, second: SceneObject) {
    if (first === second || first.body.id === second.body.id) return false
    const a = this.identity(first)
    const b = this.identity(second)
    return Boolean(a && b && a.collectionId === b.collectionId && a.level === b.level)
  }

  enqueue(first: SceneObject, second: SceneObject, impact = 0) {
    if (first === second || first.body.id === second.body.id) return false
    const firstId = Math.min(first.body.id, second.body.id)
    const secondId = Math.max(first.body.id, second.body.id)
    const key = `${firstId}:${secondId}`
    if (this.pending.has(key)) return false
    if (this.pending.size >= (this.options.maxPendingPairs ?? 512)) return false
    this.pending.set(key, { first, second, impact: Math.max(0, impact) })
    return true
  }

  /** Drop collision pairs without mutating the physical world. */
  clear() { this.pending.clear() }

  /**
   * Process all queued pairs. Returns the number of successful merges. A pair
   * can only merge once per flush, and an object consumed by an earlier merge
   * cannot participate in another merge in the same flush.
   */
  flush(): number {
    if (this.pending.size === 0) return 0
    const pairs = [...this.pending.values()]
    this.pending.clear()
    const consumed = new Set<number>()
    let mergedCount = 0

    for (const pair of pairs) {
      const firstId = pair.first.body.id
      const secondId = pair.second.body.id
      if (consumed.has(firstId) || consumed.has(secondId)) continue
      const from = this.identity(pair.first)
      const secondIdentity = this.identity(pair.second)
      if (!from || !secondIdentity || from.collectionId !== secondIdentity.collectionId || from.level !== secondIdentity.level) continue
      const next = this.options.getNextLevel(from, pair.first)
      if (!next || next.identity.collectionId !== from.collectionId || next.identity.level !== from.level + 1) continue

      const position = {
        x: (pair.first.body.position.x + pair.second.body.position.x) / 2,
        y: (pair.first.body.position.y + pair.second.body.position.y) / 2,
      }
      const mass = Math.max(0.0001, pair.first.body.mass + pair.second.body.mass)
      const velocity = {
        x: (pair.first.body.velocity.x * pair.first.body.mass + pair.second.body.velocity.x * pair.second.body.mass) / mass,
        y: (pair.first.body.velocity.y * pair.first.body.mass + pair.second.body.velocity.y * pair.second.body.mass) / mass,
      }

      try {
        // Create first so a capacity/storage failure leaves both source bodies
        // untouched. The adapter's create callback must not advance the
        // Matter engine; flush runs between engine updates.
        const result = this.options.createObject(next.definition, position, velocity)
        if (!result) continue
        // The adapter owns the actual Composite/objects-array mutation.
        this.options.removeObject(pair.first)
        this.options.removeObject(pair.second)
        consumed.add(firstId)
        consumed.add(secondId)
        mergedCount += 1
        this.options.onMerged?.({ first: pair.first, second: pair.second, result, from, to: next.identity, impact: pair.impact, position })
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    return mergedCount
  }

  private identity(object: SceneObject) {
    try { return (this.options.getIdentity ?? defaultIdentity)(object) } catch (error) {
      this.options.onError?.(error)
      return undefined
    }
  }
}

/** Convenience factory for integrations that prefer a function over a class. */
export function createMergeSystem(options: MergeSystemOptions) {
  return new MergeSystem(options)
}
