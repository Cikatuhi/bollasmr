import Matter from 'matter-js'
import type { ObjectDefinition, ObjectKind } from '../objects/definitions'
import { ballPalette, makeDefinition } from '../objects/definitions'
import { createPhysicsBody } from './bodyFactories'
import { arenaPath } from '../arena/geometry'

const { Bodies, Body, Composite, Engine, Events } = Matter

export const SCENE_WIDTH = 360
export const SCENE_HEIGHT = 640
export const MAX_OBJECTS = 150
export const MAX_BALLS = 80

export type PhysicsSettings = { gravity: number; restitution: number; speed: number }
export type SceneObject = { definition: ObjectDefinition; body: Matter.Body }

type AnimatedBody = { body: Matter.Body; originX: number; amplitude: number; period: number; phase: number }

export class SimulationScene {
  readonly engine = Engine.create({ enableSleeping: true })
  readonly objects: SceneObject[] = []
  settings: PhysicsSettings = { gravity: 1, restitution: 0.82, speed: 1 }
  private readonly walls: Matter.Body[] = []
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
        const a = this.objects.find((entry) => entry.body.id === pair.bodyA.id)
        const b = this.objects.find((entry) => entry.body.id === pair.bodyB.id)
        const impact = Math.max(pair.bodyA.speed, pair.bodyB.speed)
        if (a && b) this.collisionListener?.(a, b, impact)
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
      friction: 0.015,
      frictionAir: 0.001,
      sleepThreshold: 90,
    }
    const body = createPhysicsBody(definition, x, y, opts)
    if (definition.mass && !opts.isStatic) Body.setMass(body, definition.mass)
    const entry = { definition, body }
    this.objects.push(entry)
    Composite.add(this.engine.world, body)
    if (definition.motion?.type === 'oscillate-x') {
      this.animated.push({
        body, originX: x, amplitude: definition.motion.amplitude,
        period: definition.motion.period, phase: definition.motion.phase ?? 0,
      })
    }
    return entry
  }

  /** Remove a scene object from both the registry and Matter world. */
  removeObject(object: SceneObject) {
    const index = this.objects.indexOf(object)
    if (index < 0) return false
    Composite.remove(this.engine.world, object.body)
    this.objects.splice(index, 1)
    const animatedIndex = this.animated.findIndex((item) => item.body.id === object.body.id)
    if (animatedIndex >= 0) this.animated.splice(animatedIndex, 1)
    return true
  }

  create(kind: ObjectKind, x?: number, y?: number, overrides: Partial<ObjectDefinition> = {}) {
    const definition = makeDefinition(kind, `object-${this.nextId++}`, overrides)
    return this.addObject(definition, x, y)
  }

  createDemo(ballCount = 24) {
    this.clearObjects()
    // Keep the base scene's rectangular safety bounds available for callers
    // that use SimulationScene as a small physics sandbox. The production
    // demo additionally installs the neon bowl path below, so every object
    // created by the editor participates in the reference arena.
    this.addArenaWalls()
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
      restitution: 0.8,
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
    this.animated.length = 0
    this.elapsed = 0
  }

  updateSettings(settings: Partial<PhysicsSettings>) {
    this.settings = { ...this.settings, ...settings }
    this.engine.gravity.y = this.settings.gravity
    this.engine.timing.timeScale = this.settings.speed
    for (const { definition, body } of this.objects) {
      if (!body.isStatic) {
        definition.restitution = this.settings.restitution
        body.restitution = this.settings.restitution
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
    Engine.update(this.engine, delta)
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
    this.walls.push(
      Bodies.rectangle(-thickness / 2, SCENE_HEIGHT / 2, thickness, SCENE_HEIGHT + thickness * 2, { isStatic: true, label: 'wall' }),
      Bodies.rectangle(SCENE_WIDTH + thickness / 2, SCENE_HEIGHT / 2, thickness, SCENE_HEIGHT + thickness * 2, { isStatic: true, label: 'wall' }),
      Bodies.rectangle(SCENE_WIDTH / 2, -thickness / 2, SCENE_WIDTH + thickness * 2, thickness, { isStatic: true, label: 'wall' }),
      Bodies.rectangle(SCENE_WIDTH / 2, SCENE_HEIGHT + thickness / 2, SCENE_WIDTH + thickness * 2, thickness, { isStatic: true, label: 'wall' }),
    )
    Composite.add(this.engine.world, this.walls)
  }

  private addArenaWalls() {
    if (this.arenaWallsAdded) return
    this.arenaWallsAdded = true
    const thickness = 10
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
        friction: 0.01,
        restitution: this.settings.restitution,
      }))
    }
    this.walls.push(...arenaWalls)
    Composite.add(this.engine.world, arenaWalls)
  }

  private wallProxy(): SceneObject {
    return { definition: { id: 'wall', kind: 'box', label: 'Стена', color: 0x566077, isStatic: true }, body: this.walls[0]! }
  }
}
