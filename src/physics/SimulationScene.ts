import Matter from 'matter-js'
import { DEFAULT_RESTITUTION, type ObjectDefinition, type ObjectKind } from '../objects/definitions'
import { ballPalette, makeDefinition } from '../objects/definitions'
import { correctCompoundInertia, createPhysicsBody } from './bodyFactories'
import { registerCompoundManifoldFilter } from './compoundManifolds'
import { ARENA_CENTER, ARENA_NECK, ARENA_WALL_THICKNESS, arenaPath } from '../arena/geometry'

const { Bodies, Body, Composite, Engine, Events } = Matter

export const SCENE_WIDTH = 360
export const SCENE_HEIGHT = 640
export const MAX_OBJECTS = 150
export const MAX_BALLS = 80
/** Moderate drag lets objects keep rolling after a light touch. */
const OBJECT_FRICTION_AIR = 0.025
const OBJECT_SURFACE_FRICTION = 0.18
/** Limit pathological solver spin without flattening ordinary image rotation. */
const MAX_IMAGE_ANGULAR_STEP = 0.08
/** Spread compound-fixture overlap fixes across frames without touching velocity. */
const MAX_IMAGE_POSITION_CORRECTION = 0.35
const MATTER_BASE_DELTA = 1000 / 60
const INLET_GATE_CATEGORY = 0x0002
const INLET_GATE_THICKNESS = 8
const ALL_COLLISIONS_MASK = 0xffffffff
/** Recovery is only a last resort; never let it teleport an object across the scene. */
const MAX_BOUNDARY_RECOVERY_PER_SUBSTEP = 0.35
/** Let Matter handle shallow wall contacts; recover only clear geometric escapes. */
const BOUNDARY_RECOVERY_SLOP = 1.25
// Keep post-solver recovery in sync with the widest part of the Matter wall:
// joint circles extend farther into the arena than the tangent rectangles.
export const ARENA_WALL_INSET = ARENA_WALL_THICKNESS * 0.72
/** Keep new objects fully above the viewport, but close enough to enter promptly. */
export const ENTRANCE_DROP_DISTANCE = 48
const ENTRANCE_INITIAL_SPEED = 0.75

function nearestArenaBoundary(point: Matter.Vector) {
  let best: { x: number; y: number; normalX: number; normalY: number; distanceSquared: number } | undefined
  let winding = 0
  for (let index = 0; index < arenaPath.length; index += 1) {
    const current = arenaPath[index]!
    const next = arenaPath[(index + 1) % arenaPath.length]!
    winding += current.x * next.y - next.x * current.y
  }
  const clockwise = winding < 0

  for (let index = 1; index < arenaPath.length; index += 1) {
    const start = arenaPath[index - 1]!
    const end = arenaPath[index]!
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
    const x = start.x + dx * ratio
    const y = start.y + dy * ratio
    const distanceSquared = (point.x - x) ** 2 + (point.y - y) ** 2
    if (best && distanceSquared >= best.distanceSquared) continue
    const length = Math.max(0.0001, Math.sqrt(lengthSquared))
    // arenaPath runs clockwise in screen coordinates, so its interior lies
    // on the right-hand side of each directed segment.
    best = clockwise
      ? { x, y, normalX: dy / length, normalY: -dx / length, distanceSquared }
      : { x, y, normalX: -dy / length, normalY: dx / length, distanceSquared }
  }
  return best
}

function collisionVertices(body: Matter.Body) {
  // Matter stores a compound body's convex hull in parts[0], but that hull can
  // cross transparent cutouts in a PNG. Inspect the actual child fixtures
  // instead, falling back to the body's own vertices for simple shapes.
  const parts = body.parts.length > 1 ? body.parts.slice(1) : [body]
  return parts.flatMap((part) => part.vertices)
}

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
  private readonly releaseCompoundManifoldFilter: () => void
  private nextId = 1
  private elapsed = 0
  private collisionListener?: (a: SceneObject, b: SceneObject, impact: number) => void
  private postStepListener?: () => void

  constructor(onCollision?: (a: SceneObject, b: SceneObject, impact: number) => void) {
    this.releaseCompoundManifoldFilter = registerCompoundManifoldFilter(this.engine.detector)
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
      // PNG alpha masks are already fitted to the visible silhouette. A larger
      // slop can make Matter accept penetration as its target and pull lightly
      // touching images inward before pushing them apart.
      slop: definition.kind === 'image' ? 0.05 : 0.5,
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
    const x = ARENA_CENTER.x
    const radius = Math.max(1, definition.radius ?? 24)
    // Start well above the visible canvas. The object is already in motion
    // before it crosses the frame edge and reaches the chute entrance.
    let y = ARENA_NECK.top - radius - ENTRANCE_DROP_DISTANCE
    const gap = 12

    for (const object of this.objects) {
      const otherRadius = Math.max(1, object.definition.radius ?? 24)
      const sameLane = Math.abs(object.body.position.x - x) < radius + otherRadius + 4
      const stillEntering = object.body.position.y - otherRadius < ARENA_NECK.shoulderY + otherRadius
      if (sameLane && stillEntering) {
        y = Math.min(y, object.body.position.y - otherRadius - radius - gap)
      }
    }

    const object = this.addObject(definition, x, y)
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
    if (definition.kind === 'image') correctCompoundInertia(body)
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
    // Matter recommends updates no larger than ~16.7ms. Split delayed frames
    // and accelerated playback into stable substeps to reduce tunnelling
    // through the segmented arena walls. The input delta is capped above, so
    // this loop is bounded to at most six updates per rendered frame.
    const maxSubstep = 1000 / 60
    let remaining = scaled
    while (remaining > 0) {
      const substep = Math.min(maxSubstep, remaining)
      // Existing bodies can survive a hot module update. Keep the current
      // damping on those bodies too, not only on bodies created after reload.
      for (const { body } of this.objects) {
        if (!body.isStatic) {
          body.frictionAir = OBJECT_FRICTION_AIR
          if (body.parts.length > 1 && Math.abs(body.angularVelocity) > MAX_IMAGE_ANGULAR_STEP) {
            Body.setAngularVelocity(body, Math.sign(body.angularVelocity) * MAX_IMAGE_ANGULAR_STEP)
          }
        }
      }
      const imagePositions = this.objects.flatMap(({ body }) => body.parts.length > 1
        ? [{ body, x: body.position.x, y: body.position.y }]
        : [])
      Engine.update(this.engine, substep)
      this.limitLargeImagePositionCorrections(imagePositions)
      for (const { body } of this.objects) {
        this.updateEntranceState(body)
      }
      this.retainEscapedObjects()
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
    this.releaseCompoundManifoldFilter()
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
    // Each short rectangle is a tangent segment. Slight overlap between
    // neighboring segments prevents Matter bodies from leaking through the
    // sampled circular boundary while keeping the collision shape stable.
    const arenaWalls: Matter.Body[] = []
    for (let index = 1; index < arenaPath.length; index += 1) {
      const start = arenaPath[index - 1]!
      const end = arenaPath[index]!
      const dx = end.x - start.x
      const dy = end.y - start.y
      const length = Math.max(1, Math.hypot(dx, dy)) + 7
      arenaWalls.push(Bodies.rectangle((start.x + end.x) / 2, (start.y + end.y) / 2, length, thickness, {
        isStatic: true,
        label: 'wall',
        angle: Math.atan2(dy, dx),
        friction: OBJECT_SURFACE_FRICTION,
        restitution: this.settings.restitution,
      }))
    }
    // Tangent rectangles leave tiny wedge-shaped gaps on the outside of a
    // bend even when their ends overlap. Round joints bridge every sampled
    // vertex, preventing Matter's discrete collision solver from letting a
    // fast or compound PNG body slip through the lower arc under pressure.
    for (const point of arenaPath) {
      arenaWalls.push(Bodies.circle(point.x, point.y, ARENA_WALL_INSET, {
        isStatic: true,
        label: 'wall',
        friction: OBJECT_SURFACE_FRICTION,
        restitution: this.settings.restitution,
      }))
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
    let topExtent = 0
    for (const vertex of collisionVertices(body)) topExtent = Math.max(topExtent, body.position.y - vertex.y)
    const fullyInside = body.position.y - topExtent >= ARENA_NECK.top + INLET_GATE_THICKNESS / 2
    body.collisionFilter.mask = fullyInside
      ? ALL_COLLISIONS_MASK
      : ALL_COLLISIONS_MASK & ~INLET_GATE_CATEGORY
    if (fullyInside) this.enteredArena.add(body.id)
  }

  /**
   * Matter uses discrete collision steps. In a crowded bowl, several contacts
   * can push a body through a thin segmented wall between frames. Keep the
   * actual Matter walls as the primary collision surface, then recover only a
   * body whose centre has escaped the arena so it cannot fall into the page
   * safety floor and appear outside the rendered bowl.
   */
  private retainEscapedObjects() {
    if (!this.arenaWallsAdded) return
    const clearance = ARENA_WALL_INSET
    for (const { body } of this.objects) {
      if (body.isStatic || !this.enteredArena.has(body.id)) continue
      if (body.position.y < ARENA_NECK.top) {
        // The path deliberately has no top cap so new objects can fall in.
        // A fully-entered body is normally caught by the one-way gate. If a
        // pathological frame still tunnels it above the mouth, recover only
        // a tiny amount per substep instead of teleporting it back into view.
        let topExtent = 0
        let leftExtent = 0
        let rightExtent = 0
        for (const vertex of collisionVertices(body)) {
          topExtent = Math.max(topExtent, body.position.y - vertex.y)
          leftExtent = Math.max(leftExtent, body.position.x - vertex.x)
          rightExtent = Math.max(rightExtent, vertex.x - body.position.x)
        }
        const minX = ARENA_NECK.left + leftExtent + clearance
        const maxX = ARENA_NECK.right - rightExtent - clearance
        const x = minX <= maxX
          ? Math.max(minX, Math.min(maxX, body.position.x))
          : ARENA_CENTER.x
        const target = { x, y: ARENA_NECK.top + topExtent + clearance + 0.1 }
        const dx = target.x - body.position.x
        const dy = target.y - body.position.y
        const distance = Math.hypot(dx, dy)
        const fraction = distance > MAX_BOUNDARY_RECOVERY_PER_SUBSTEP
          ? MAX_BOUNDARY_RECOVERY_PER_SUBSTEP / distance
          : 1
        Body.setPosition(body, {
          x: body.position.x + dx * fraction,
          y: body.position.y + dy * fraction,
        })
        if (body.velocity.y < 0) {
          Body.setVelocity(body, { x: body.velocity.x, y: -body.velocity.y * body.restitution })
        }
        continue
      }

      const boundary = nearestArenaBoundary(body.position)
      if (!boundary) continue

      // A compound PNG can straddle the wall while its centre is still on
      // the inside. Measure its full support radius against the signed inward
      // distance to the closest path segment instead of checking its centre
      // alone. Positive signed distance means the centre is inside; the
      // support extent is how far its outer shell reaches back toward/outside
      // the wall.
      const signedDistance = (body.position.x - boundary.x) * boundary.normalX +
        (body.position.y - boundary.y) * boundary.normalY
      let outwardExtent = 0
      for (const vertex of collisionVertices(body)) {
        const projection = (vertex.x - body.position.x) * boundary.normalX +
          (vertex.y - body.position.y) * boundary.normalY
        outwardExtent = Math.max(outwardExtent, -projection)
      }
      // The path is an ideal curve, while Matter collides against overlapping
      // tangent rectangles and round joints. Their contact manifold can leave
      // a small apparent protrusion relative to this ideal path on every
      // frame. Treat that as normal contact: otherwise recovery continuously
      // nudges a resting body inward after Matter has already resolved it.
      const correction = outwardExtent + clearance - signedDistance - BOUNDARY_RECOVERY_SLOP
      if (correction <= 0) continue
      // A high-speed body may already be far beyond the wall after a single
      // discrete step; restore that pathological tunnel immediately. For a
      // slow body, a large projection is more likely a solver/contact glitch
      // and should not become a visible teleport.
      const boundedCorrection = body.speed > 8
        ? correction
        : Math.min(correction, MAX_BOUNDARY_RECOVERY_PER_SUBSTEP)
      Body.setPosition(body, {
        x: body.position.x + boundary.normalX * boundedCorrection,
        y: body.position.y + boundary.normalY * boundedCorrection,
      })

      // Only reflect a body that has actually crossed the path. If it is
      // merely touching the wall, Matter's own contact solver already handled
      // the bounce; reflecting here as well would double its impulse and make
      // crowded scenes visibly jump.
      const crossedBoundary = signedDistance < outwardExtent - 0.5
      const normalVelocity = body.velocity.x * boundary.normalX + body.velocity.y * boundary.normalY
      if (crossedBoundary && normalVelocity < 0) {
        const bounce = (1 + body.restitution) * normalVelocity
        Body.setVelocity(body, {
          x: body.velocity.x - boundary.normalX * bounce,
          y: body.velocity.y - boundary.normalY * bounce,
        })
      }
    }
  }

  private wallProxy(): SceneObject {
    return { definition: { id: 'wall', kind: 'box', label: 'Стена', color: 0x566077, isStatic: true }, body: this.walls[0]! }
  }

  /**
   * Compound PNGs can produce several simultaneous fixture contacts. In a
   * packed pile Matter may resolve their accumulated penetration as a large
   * position-only jump, despite there being almost no velocity/impact. Keep
   * the body's momentum intact and apply oversized depenetration over a few
   * substeps instead of scaling collision velocity (which made contacts feel
   * sticky and removed momentum from the system).
   */
  private limitLargeImagePositionCorrections(previous: Array<{ body: Matter.Body; x: number; y: number }>) {
    for (const { body, x, y } of previous) {
      if (body.isStatic || body.isSleeping) continue
      // Matter reports velocity in base-frame units after Engine.update,
      // while this snapshot spans the actual (possibly slowed) substep.
      // Scale it back to substep displacement before isolating solver motion.
      const actualDelta = (body as Matter.Body & { deltaTime: number }).deltaTime
      const substepScale = actualDelta / MATTER_BASE_DELTA
      const correctionX = body.position.x - x - body.velocity.x * substepScale
      const correctionY = body.position.y - y - body.velocity.y * substepScale
      const correctionLength = Math.hypot(correctionX, correctionY)
      if (correctionLength <= MAX_IMAGE_POSITION_CORRECTION) continue

      const retention = MAX_IMAGE_POSITION_CORRECTION / correctionLength
      Body.setPosition(body, {
        x: body.position.x - correctionX * (1 - retention),
        y: body.position.y - correctionY * (1 - retention),
      })
      // Keep Matter's cached positional warm-start in proportion to the
      // correction actually applied, avoiding the same full shove next frame.
      const solverBody = body as Matter.Body & { positionImpulse: Matter.Vector }
      solverBody.positionImpulse.x *= retention
      solverBody.positionImpulse.y *= retention
    }
  }

}
