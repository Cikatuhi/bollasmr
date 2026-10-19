import Matter from 'matter-js'
import { DEFAULT_RESTITUTION, type ObjectDefinition, type ObjectKind } from '../objects/definitions'
import { ballPalette, makeDefinition } from '../objects/definitions'
import { createPhysicsBody } from './bodyFactories'
import { ARENA_CENTER, ARENA_NECK, ARENA_WALL_THICKNESS, arenaPath } from '../arena/geometry'

const { Bodies, Body, Composite, Engine, Events } = Matter

export const SCENE_WIDTH = 360
export const SCENE_HEIGHT = 640
export const MAX_OBJECTS = 150
export const MAX_BALLS = 80
/** Moderate drag lets objects keep rolling after a light touch. */
const OBJECT_FRICTION_AIR = 0.025
const OBJECT_SURFACE_FRICTION = 0.18
const INLET_GATE_CATEGORY = 0x0002
const INLET_GATE_THICKNESS = 8
const ALL_COLLISIONS_MASK = 0xffffffff
/** Keep new objects fully above the viewport, but close enough to enter promptly. */
export const ENTRANCE_DROP_DISTANCE = 48
const ENTRANCE_INITIAL_SPEED = 0.75

export type PhysicsSettings = { gravity: number; restitution: number; speed: number }
export type SceneObject = { definition: ObjectDefinition; body: Matter.Body }

type AnimatedBody = { body: Matter.Body; originX: number; amplitude: number; period: number; phase: number }

export class SimulationScene {
  readonly engine = Engine.create({
    enableSleeping: true,
    // Dense PNG scenes have many simultaneous contacts. A few extra solver
    // iterations reduce penetration corrections and the resulting jitter.
    positionIterations: 8,
    velocityIterations: 6,
    constraintIterations: 2,
  })
  readonly objects: SceneObject[] = []
  settings: PhysicsSettings = { gravity: 1, restitution: DEFAULT_RESTITUTION, speed: 1 }
  private readonly walls: Matter.Body[] = []
  /** Bodies that crossed the open mouth on their way into the one-way arena. */
  private readonly enteredArena = new Set<number>()
  private topSafetyWall?: Matter.Body
  private arenaWallsAdded = false
  private readonly animated: AnimatedBody[] = []
  private nextId = 1
  private elapsed = 0
  private collisionListener?: (a: SceneObject, b: SceneObject, impact: number) => void
  private postStepListener?: () => void

  constructor(onCollision?: (a: SceneObject, b: SceneObject, impact: number) => void) {
    this.engine.gravity.x = 0
    this.engine.gravity.y = this.settings.gravity
    this.engine.gravity.scale = 0.001
    this.collisionListener = onCollision
    Events.on(this.engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) {
        // Matter reports compound-child parts in collision pairs. Normalize
        // back to their registered scene bodies so image objects still merge
        // and do not get mistaken for wall contacts.
        const bodyA = pair.bodyA.parent ?? pair.bodyA
        const bodyB = pair.bodyB.parent ?? pair.bodyB
        const a = this.objects.find((entry) => entry.body.id === bodyA.id)
        const b = this.objects.find((entry) => entry.body.id === bodyB.id)
        const impact = Math.max(bodyA.speed, bodyB.speed)
        if (a && b) {
          this.collisionListener?.(a, b, impact)
        }
        else if (a || b) this.collisionListener?.(a ?? this.wallProxy(), b ?? this.wallProxy(), impact)
      }
    })
    this.addWalls()
  }

  setCollisionListener(listener?: (a: SceneObject, b: SceneObject, impact: number) => void) {
    this.collisionListener = listener
  }

  /**
   * Register work that must run after Matter has finished Engine.update.
   * Deferred merge coordinators use this hook to remove/create bodies safely.
   */
  setPostStepListener(listener?: () => void) {
    this.postStepListener = listener
  }

  addObject(definition: ObjectDefinition, x = SCENE_WIDTH / 2, y = 80): SceneObject | undefined {
    if (this.objects.length >= MAX_OBJECTS) return undefined
    const opts: Matter.IBodyDefinition = {
      label: definition.label,
      isStatic: definition.isStatic ?? false,
      density: definition.density ?? 0.002,
      restitution: definition.restitution ?? this.settings.restitution,
      friction: OBJECT_SURFACE_FRICTION,
      frictionAir: OBJECT_FRICTION_AIR,
      // Use Matter's small contact slop consistently across bodies. A larger
      // image-only slop made mixed PNG/object contacts behave differently.
      slop: 0.05,
      sleepThreshold: 90,
    }
    const body = createPhysicsBody(definition, x, y, opts)
    if (definition.mass && !opts.isStatic) Body.setMass(body, definition.mass)
    const entry = { definition, body }
    this.objects.push(entry)
    Composite.add(this.engine.world, body)
    this.updateEntranceState(body)
    if (definition.motion?.type === 'oscillate-x') {
      this.animated.push({
        body, originX: x, amplitude: definition.motion.amplitude,
        period: definition.motion.period, phase: definition.motion.phase ?? 0,
      })
    }
    return entry
  }

  /**
   * Add a user object above the arena mouth so gravity carries it into the
   * chute. Existing objects still in the entry lane are stacked below it;
   * this keeps quick consecutive uploads from spawning inside one another.
   */
  spawnFromEntrance(definition: ObjectDefinition): SceneObject | undefined {
    const radius = Math.max(1, definition.radius ?? 24)
    // A silhouette may be asymmetric, and Matter can rotate it while queued
    // above the inlet. Place it at the inlet center and use the actual Matter
    // bounds (including any angled/compound vertices) for safe stacking.
    const x = ARENA_CENTER.x
    // Start well above the visible canvas. The object is already in motion
    // before it crosses the frame edge and reaches the chute entrance.
    let y = ARENA_NECK.top - radius - ENTRANCE_DROP_DISTANCE
    const gap = 12
    const candidate = createPhysicsBody(definition, x, y, {
      density: definition.density ?? 0.002,
      restitution: definition.restitution ?? this.settings.restitution,
      friction: OBJECT_SURFACE_FRICTION,
      frictionAir: OBJECT_FRICTION_AIR,
      slop: 0.05,
      sleepThreshold: 90,
    })
    const candidateHalfWidth = (candidate.bounds.max.x - candidate.bounds.min.x) / 2
    const candidateHalfHeight = (candidate.bounds.max.y - candidate.bounds.min.y) / 2
    const candidateCenterOffsetX = (candidate.bounds.min.x + candidate.bounds.max.x) / 2 - candidate.position.x
    const candidateCenterOffsetY = (candidate.bounds.min.y + candidate.bounds.max.y) / 2 - candidate.position.y
    const inletHalfWidth = (ARENA_NECK.right - ARENA_NECK.left) / 2 - ARENA_WALL_THICKNESS
    if (candidateHalfWidth > inletHalfWidth) {
      // Saved sizes can exceed the current editor limit; do not inject a body
      // that physically cannot pass through the opening.
      return undefined
    }
    const placementX = ARENA_CENTER.x - candidateCenterOffsetX
    Matter.Body.setPosition(candidate, { x: placementX, y })
    Matter.Composite.remove(this.engine.world, candidate)
    // The probe is intentionally never registered in the scene or engine.

    for (const object of this.objects) {
      const otherBounds = object.body.bounds
      const sameLane = Math.abs(object.body.position.x - placementX) < candidateHalfWidth + (otherBounds.max.x - otherBounds.min.x) / 2 + 4
      const stillEntering = otherBounds.min.y < ARENA_NECK.shoulderY + (otherBounds.max.y - otherBounds.min.y)
      if (sameLane && stillEntering) {
        y = Math.min(y, otherBounds.min.y - candidateHalfHeight - candidateCenterOffsetY - gap - 1)
      }
    }

    const object = this.addObject(definition, placementX, y)
    if (object) Body.setVelocity(object.body, { x: 0, y: ENTRANCE_INITIAL_SPEED })
    return object
  }

  /** Remove a scene object from both the registry and Matter world. */
  removeObject(object: SceneObject) {
    const index = this.objects.indexOf(object)
    if (index < 0) return false
    Composite.remove(this.engine.world, object.body)
    this.objects.splice(index, 1)
    this.enteredArena.delete(object.body.id)
    const animatedIndex = this.animated.findIndex((item) => item.body.id === object.body.id)
    if (animatedIndex >= 0) this.animated.splice(animatedIndex, 1)
    return true
  }

  create(kind: ObjectKind, x?: number, y?: number, overrides: Partial<ObjectDefinition> = {}) {
    const definition = makeDefinition(kind, `object-${this.nextId++}`, overrides)
    return this.addObject(definition, x, y)
  }

  createFromEntrance(kind: ObjectKind, overrides: Partial<ObjectDefinition> = {}) {
    const definition = makeDefinition(kind, `object-${this.nextId++}`, overrides)
    return this.spawnFromEntrance(definition)
  }

  createDemo(ballCount = 24) {
    this.clearObjects()
    // Keep the base scene's rectangular safety bounds available for callers
    // that use SimulationScene as a small physics sandbox. The production
    // demo additionally installs the neon bowl path below, so every object
    // created by the editor participates in the reference arena.
    this.initializeArena()
    const count = Math.min(MAX_BALLS, Math.max(1, Math.floor(ballCount)))
    // Keep the original moving obstacle in the demo. Apart from preserving
    // the public demo contract (and existing tests), it gives the first mode
    // a simple example of a dynamic arena element. The neon boundary itself
    // remains a static Matter path below the object layer.
    this.create('box', SCENE_WIDTH / 2, 315, {
      id: `platform-${this.nextId++}`,
      label: 'Движущаяся платформа',
      width: 106,
      height: 9,
      color: 0x20263d,
      isStatic: true,
      restitution: DEFAULT_RESTITUTION,
      motion: { type: 'oscillate-x', amplitude: 43, period: 3.8, phase: 0 },
    })
    for (let index = 0; index < count; index += 1) {
      const radius = 10 + ((index * 7) % 8)
      const definition = makeDefinition('circle', `ball-${this.nextId++}`, {
        label: `Шар ${index + 1}`, color: ballPalette[index % ballPalette.length], radius,
        restitution: this.settings.restitution, density: 0.0018 + (index % 3) * 0.0003,
      })
      // The first objects form the recognizable drop column. Remaining
      // objects are staged inside the bowl so the arena is lively on reset.
      const inDropColumn = index < 9
      const x = inDropColumn ? SCENE_WIDTH / 2 + ((index % 2) ? 1 : -1) : 180 + Math.cos(index * 2.7) * (45 + (index % 3) * 21)
      const y = inDropColumn ? 28 + index * 31 : 190 + (Math.sin(index * 1.7) * 0.5 + 0.5) * 170
      const entry = this.addObject(definition, x, y)
      if (entry) Body.setVelocity(entry.body, { x: Math.sin(index * 1.8) * 1.2, y: (index % 3) * 0.3 })
    }
  }

  clearObjects() {
    for (const { body } of this.objects) Composite.remove(this.engine.world, body)
    this.objects.length = 0
    this.enteredArena.clear()
    this.animated.length = 0
    this.elapsed = 0
  }

  /** Adds the neon arena collision path without seeding any demo objects. */
  initializeArena() {
    // The generic physics sandbox retains its ceiling, but it seals the
    // production arena's open top. Remove just that safety cap once the chute
    // walls are installed; side and floor bounds remain in place.
    if (this.topSafetyWall) {
      Composite.remove(this.engine.world, this.topSafetyWall)
      const index = this.walls.indexOf(this.topSafetyWall)
      if (index >= 0) this.walls.splice(index, 1)
      this.topSafetyWall = undefined
    }
    this.addArenaWalls()
  }

  updateSettings(settings: Partial<PhysicsSettings>) {
    this.settings = { ...this.settings, ...settings }
    this.engine.gravity.y = this.settings.gravity
    // Speed is applied by SimulationScene.step() using bounded physics
    // substeps. Leaving Matter's own timeScale at 2 would turn each substep
    // into another oversized step and reintroduce wall tunnelling.
    this.engine.timing.timeScale = 1
    for (const { definition, body } of this.objects) {
      if (!body.isStatic) {
        definition.restitution = this.settings.restitution
        body.restitution = this.settings.restitution
        body.frictionAir = OBJECT_FRICTION_AIR
      }
    }
    for (const wall of this.walls) wall.restitution = this.settings.restitution
  }

  updateObject(id: string, patch: Partial<ObjectDefinition>) {
    const entry = this.objects.find((item) => item.definition.id === id)
    if (!entry) return undefined
    const { definition, body } = entry
    const isBox = (patch.visual ?? definition.visual) === 'box'
    if (isBox) {
      const oldWidth = definition.width ?? 80
      const oldHeight = definition.height ?? 12
      const newWidth = patch.width ?? oldWidth
      const newHeight = patch.height ?? oldHeight
      const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1
      const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1
      if (scaleX !== 1 || scaleY !== 1) Body.scale(body, scaleX, scaleY)
    } else {
      const oldSize = (definition.radius ?? 20) * 2
      const newSize = (patch.radius ?? definition.radius ?? 20) * 2
      if (oldSize > 0 && newSize !== oldSize) Body.scale(body, newSize / oldSize, newSize / oldSize)
    }
    Object.assign(definition, patch)
    const targetMass = patch.mass ?? definition.mass
    if (targetMass && !body.isStatic) Body.setMass(body, targetMass)
    if (patch.restitution !== undefined) body.restitution = patch.restitution
    if (patch.isStatic !== undefined) Body.setStatic(body, patch.isStatic)
    return entry
  }

  step(deltaMs = 1000 / 60) {
    const delta = Math.max(0, Math.min(deltaMs, 50))
    const scaled = delta * this.settings.speed
    this.elapsed += scaled / 1000
    for (const item of this.animated) {
      const x = item.originX + Math.sin((this.elapsed / item.period) * Math.PI * 2 + item.phase) * item.amplitude
      Body.setPosition(item.body, { x, y: item.body.position.y })
      Body.setVelocity(item.body, { x: 0, y: 0 })
    }
    // Split each rendered frame into 240Hz Matter steps. Faster discrete
    // collision sampling reduces deep penetrations in a dense stream of
    // falling PNGs before Matter's stock position solver resolves contacts.
    const maxSubstep = 1000 / 240
    let remaining = scaled
    while (remaining > 0) {
      const substep = Math.min(maxSubstep, remaining)
      // Existing bodies can survive a hot module update. Keep the current
      // damping on those bodies too, not only on bodies created after reload.
      for (const { body } of this.objects) {
        if (!body.isStatic) body.frictionAir = OBJECT_FRICTION_AIR
      }
      Engine.update(this.engine, substep)
      for (const { body } of this.objects) {
        this.updateEntranceState(body)
      }
      remaining -= substep
    }
    this.postStepListener?.()
  }

  findObject(id: string) { return this.objects.find((item) => item.definition.id === id) }

  moveObject(id: string, x: number, y: number, velocity = { x: 0, y: 0 }) {
    const entry = this.findObject(id)
    if (!entry) return
    Body.setPosition(entry.body, { x, y })
    Body.setVelocity(entry.body, velocity)
    Body.setAngularVelocity(entry.body, 0)
  }

  destroy() {
    this.clearObjects()
    Composite.clear(this.engine.world, false)
    Events.off(this.engine, 'collisionStart')
    this.collisionListener = undefined
    this.postStepListener = undefined
  }

  private addWalls() {
    // Invisible safety bounds keep the base physics scene finite. The curved
    // arena path is installed separately for the editor demo in
    // addArenaWalls(), while these bounds remain useful for headless callers
    // and legacy physics scenarios.
    const thickness = 28
    const leftWall = Bodies.rectangle(-thickness / 2, SCENE_HEIGHT / 2, thickness, SCENE_HEIGHT + thickness * 2, { isStatic: true, label: 'wall' })
    const rightWall = Bodies.rectangle(SCENE_WIDTH + thickness / 2, SCENE_HEIGHT / 2, thickness, SCENE_HEIGHT + thickness * 2, { isStatic: true, label: 'wall' })
    this.topSafetyWall = Bodies.rectangle(SCENE_WIDTH / 2, -thickness / 2, SCENE_WIDTH + thickness * 2, thickness, { isStatic: true, label: 'wall' })
    const floorWall = Bodies.rectangle(SCENE_WIDTH / 2, SCENE_HEIGHT + thickness / 2, SCENE_WIDTH + thickness * 2, thickness, { isStatic: true, label: 'wall' })
    this.walls.push(
      leftWall,
      rightWall,
      this.topSafetyWall,
      floorWall,
    )
    Composite.add(this.engine.world, this.walls)
  }

  private addArenaWalls() {
    if (this.arenaWallsAdded) return
    this.arenaWallsAdded = true
    const thickness = ARENA_WALL_THICKNESS
    // Build a continuous polygonal wall strip. Tangent rectangles leave wedge
    // gaps at bends (or need overlapping end caps); those gaps either leak
    // objects or create multiple competing contact manifolds. Adjacent quads
    // here share the exact same cross-section at every sampled path point.
    const winding = arenaPath.reduce((sum, point, index) => {
      const next = arenaPath[(index + 1) % arenaPath.length]!
      return sum + point.x * next.y - next.x * point.y
    }, 0)
    const interiorSide = winding < 0 ? 1 : -1
    const halfThickness = thickness / 2
    const offsetPath = arenaPath.map((point, index) => {
      const previous = arenaPath[Math.max(0, index - 1)]!
      const next = arenaPath[Math.min(arenaPath.length - 1, index + 1)]!
      const incomingLength = Math.hypot(point.x - previous.x, point.y - previous.y) || 1
      const outgoingLength = Math.hypot(next.x - point.x, next.y - point.y) || 1
      const incoming = { x: (point.x - previous.x) / incomingLength, y: (point.y - previous.y) / incomingLength }
      const outgoing = { x: (next.x - point.x) / outgoingLength, y: (next.y - point.y) / outgoingLength }
      const incomingNormal = { x: incoming.y * interiorSide, y: -incoming.x * interiorSide }
      const outgoingNormal = { x: outgoing.y * interiorSide, y: -outgoing.x * interiorSide }
      const normal = {
        x: incomingNormal.x + outgoingNormal.x,
        y: incomingNormal.y + outgoingNormal.y,
      }
      const normalLength = Math.hypot(normal.x, normal.y) || 1
      normal.x /= normalLength
      normal.y /= normalLength
      const projection = Math.max(0.5, normal.x * outgoingNormal.x + normal.y * outgoingNormal.y)
      const offset = halfThickness / projection
      return {
        inner: { x: point.x + normal.x * offset, y: point.y + normal.y * offset },
        outer: { x: point.x - normal.x * offset, y: point.y - normal.y * offset },
      }
    })
    const arenaWalls: Matter.Body[] = []
    for (let index = 1; index < offsetPath.length; index += 1) {
      const start = offsetPath[index - 1]!
      const end = offsetPath[index]!
      const vertices = [start.inner, end.inner, end.outer, start.outer]
      const centroid = Matter.Vertices.centre(vertices)
      arenaWalls.push(Bodies.fromVertices(centroid.x, centroid.y, [vertices], {
        isStatic: true,
        label: 'wall',
        friction: OBJECT_SURFACE_FRICTION,
        restitution: this.settings.restitution,
      })!)
    }
    // Keep the mouth visually open while making it one-way. New bodies ignore
    // this offscreen gate until their entire collision shell has passed below
    // it; after that it prevents a packed pile from ejecting bodies back out
    // through the open top and triggering a long corrective teleport.
    arenaWalls.push(Bodies.rectangle(
      ARENA_CENTER.x,
      ARENA_NECK.top,
      ARENA_NECK.right - ARENA_NECK.left,
      INLET_GATE_THICKNESS,
      {
        isStatic: true,
        label: 'inlet-gate',
        collisionFilter: { category: INLET_GATE_CATEGORY, mask: ALL_COLLISIONS_MASK },
        friction: OBJECT_SURFACE_FRICTION,
        restitution: this.settings.restitution,
      },
    ))
    this.walls.push(...arenaWalls)
    Composite.add(this.engine.world, arenaWalls)
    for (const { body } of this.objects) this.updateEntranceState(body)
  }

  /**
   * The mouth is open for incoming objects, then becomes a one-way barrier
   * once the whole body has passed it. This avoids snapping an escaped body
   * horizontally back into the narrow inlet under dense contact pressure.
   */
  private updateEntranceState(body: Matter.Body) {
    if (!this.arenaWallsAdded) return
    // Once an object has entered, keep the inlet gate collision enabled even
    // if it is later pushed upward. Disabling it again let returning objects
    // escape through the open mouth (especially with smaller time steps).
    if (this.enteredArena.has(body.id)) {
      body.collisionFilter.mask = ALL_COLLISIONS_MASK
      return
    }
    const topExtent = body.position.y - body.bounds.min.y
    const fullyInside = body.position.y - topExtent >= ARENA_NECK.top + INLET_GATE_THICKNESS / 2
    if (fullyInside) {
      this.enteredArena.add(body.id)
      body.collisionFilter.mask = ALL_COLLISIONS_MASK
    } else {
      body.collisionFilter.mask = ALL_COLLISIONS_MASK & ~INLET_GATE_CATEGORY
    }
  }

  private wallProxy(): SceneObject {
    return { definition: { id: 'wall', kind: 'box', label: 'Стена', color: 0x566077, isStatic: true }, body: this.walls[0]! }
  }

}
