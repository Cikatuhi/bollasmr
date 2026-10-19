import { describe, expect, it } from 'vitest'
import Matter, { Body, Query } from 'matter-js'
import { ENTRANCE_DROP_DISTANCE, MAX_OBJECTS, SCENE_HEIGHT, SimulationScene, type SceneObject } from './SimulationScene'
import { DEFAULT_RESTITUTION, makeDefinition, registerObjectTemplate, type ObjectKind } from '../objects/definitions'
import { registerPhysicsBodyFactory } from './bodyFactories'
import { ARENA_NECK, ARENA_CENTER, ARENA_RADIUS } from '../arena/geometry'
import { imageCollisionGeometryFromAlpha } from '../objects/imageCollisionGeometry'

describe('SimulationScene', () => {
  it('leaves a lower safe area for short-form video captions', () => {
    const arenaBottom = ARENA_CENTER.y + ARENA_RADIUS
    expect(SCENE_HEIGHT - arenaBottom).toBeGreaterThanOrEqual(SCENE_HEIGHT * 0.3)
    expect(ARENA_NECK.shoulderY).toBeLessThan(180)
  })

  it('starts without demo objects and can initialize the arena by itself', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    expect(scene.objects).toHaveLength(0)
    expect(scene.engine.world.bodies.length).toBeGreaterThan(4)
    scene.destroy()
  })

  it('builds the arena from one thin Matter wall per path segment, without overlapping joint colliders', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    const arenaWalls = scene.engine.world.bodies.filter((body) => body.label === 'wall' && !body.isSensor)

    expect(arenaWalls.length).toBeGreaterThan(50)
    expect(arenaWalls.every((body) => body.vertices.length === 4)).toBe(true)
    scene.destroy()
  })

  it('does not repeatedly nudge or bounce an object from a light arena-wall touch', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    scene.updateSettings({ gravity: 0 })
    const shallowProtrusion = 0.75
    const ball = scene.addObject(makeDefinition('circle', 'resting-wall-contact', {
      radius: 16, restitution: 0,
    }), ARENA_CENTER.x, ARENA_CENTER.y + ARENA_RADIUS - 5 - 16 + shallowProtrusion)
    const start = { x: ball!.body.position.x, y: ball!.body.position.y }

    // A gentle inward/downward touch should be absorbed by the configured
    // near-inelastic Matter contact, not amplified by neighboring wall pieces.
    Body.setVelocity(ball!.body, { x: 0, y: 0.5 })
    for (let index = 0; index < 8; index += 1) scene.step(1000 / 60)

    expect(ball!.body.speed).toBeLessThan(0.1)
    for (let index = 0; index < 112; index += 1) scene.step(1000 / 60)
    expect(Math.hypot(ball!.body.position.x - start.x, ball!.body.position.y - start.y)).toBeLessThan(1.2)
    scene.destroy()
  })

  it('uses a circular Matter shell for PNGs while preserving image metadata', () => {
    const size = 12
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (x < 3 || x >= 9 || y < 3 || y >= 9) alpha[y * size + x] = 255
      }
    }
    const imageGeometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    const image = scene.addObject(makeDefinition('image', 'user-cat', {
      visual: 'image', imageSrc: 'blob:test-image', imageGeometry, radius: 28, collectionId: 'cats', level: 1,
    }), 180, 80)!
    expect(image.definition.visual).toBe('image')
    expect(image.body.circleRadius).toBe(28)
    expect(image.body.parts).toHaveLength(1)
    expect(Query.point([image.body], { x: image.body.position.x, y: image.body.position.y })).toHaveLength(1)
    expect(Query.point([image.body], { x: image.body.position.x - 27, y: image.body.position.y })).toHaveLength(1)
    expect(scene.objects).toEqual([image])
    expect(scene.engine.world.bodies).toContain(image.body)
    scene.destroy()
  })

  it('keeps PNG mass and size settings on the circular shell', () => {
    const scene = new SimulationScene()
    const image = scene.addObject(makeDefinition('image', 'offset-inertia-image', {
      radius: 24, mass: 1,
    }), 180, 250)!
    expect(image.body.mass).toBe(1)
    scene.updateObject(image.definition.id, { radius: 33, mass: 1.5 })
    expect(image.body.circleRadius).toBe(33)
    expect(image.body.mass).toBe(1.5)
    scene.destroy()
  })

  it('maps Matter compound-part collision events back to their scene objects', () => {
    const size = 8
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (x < 2 || x >= 6 || y < 2 || y >= 6) alpha[y * size + x] = 255
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    let collided = false
    const scene = new SimulationScene((a, b) => {
      if (new Set([a.definition.id, b.definition.id]).has('merge-image-a') &&
          new Set([a.definition.id, b.definition.id]).has('merge-image-b')) collided = true
    })
    const first = scene.addObject(makeDefinition('image', 'merge-image-a', { radius: 20, imageGeometry: geometry }), 130, 240)!
    const second = scene.addObject(makeDefinition('image', 'merge-image-b', { radius: 20, imageGeometry: geometry }), 180, 240)!
    Body.setVelocity(first.body, { x: 3, y: 0 })
    Body.setVelocity(second.body, { x: -3, y: 0 })
    for (let index = 0; index < 30; index += 1) scene.step(1000 / 60)
    expect(collided).toBe(true)
    scene.destroy()
  })

  it('drops user objects through the open top entrance instead of creating them in the bowl', () => {
    const scene = new SimulationScene()
    const safetyCeiling = scene.engine.world.bodies.find((body) => body.position.y < 0 && body.bounds.min.x < 0 && body.bounds.max.x > 360)
    expect(safetyCeiling).toBeDefined()

    scene.initializeArena()
    // The arena inlet starts at the canvas edge. New objects are created
    // off-screen and then fall through the visible neck into the bowl.
    expect(ARENA_NECK.top).toBeLessThanOrEqual(0)
    expect(scene.engine.world.bodies).not.toContain(safetyCeiling)
    const incoming = scene.spawnFromEntrance(makeDefinition('image', 'incoming', { radius: 24, visual: 'image' }))!
    expect(incoming.body.position.x).toBe(ARENA_CENTER.x)
    expect(incoming.body.position.y).toBe(ARENA_NECK.top - 24 - ENTRANCE_DROP_DISTANCE)
    expect(incoming.body.position.y + 24).toBeLessThan(0)
    expect(incoming.body.velocity.y).toBeGreaterThan(0)
    expect(scene.engine.world.bodies).toContain(incoming.body)

    // On the first visible frame the object is still approaching the mouth,
    // rather than being created in the bowl or appearing inside the funnel.
    let steps = 0
    while (incoming.body.position.y + 24 < 0 && steps < 120) {
      scene.step(1000 / 60)
      steps += 1
    }
    expect(steps).toBeLessThan(120)
    expect(incoming.body.position.y).toBeLessThan(ARENA_NECK.top)
    expect(incoming.body.velocity.y).toBeGreaterThan(0)

    for (let index = 0; index < 120; index += 1) scene.step(1000 / 60)
    expect(incoming.body.position.y).toBeGreaterThan(ARENA_NECK.shoulderY)

    // The segmented Matter boundary must retain the arriving body instead of
    // letting it leak through the bowl and fall to the scene's safety floor.
    for (let index = 0; index < 360; index += 1) scene.step(1000 / 60)
    expect(incoming.body.position.y).toBeLessThan(ARENA_CENTER.y + ARENA_RADIUS + 48)
    expect(incoming.body.position.y).toBeLessThan(SCENE_HEIGHT - 100)
    scene.destroy()
  })

  it('uses a continuous circular shell for an enlarged asymmetric PNG in the entrance', () => {
    const size = 12
    const alpha = new Uint8Array(size * size)
    for (let y = 2; y < 6; y += 1) for (let x = 0; x < 10; x += 1) alpha[y * size + x] = 255
    for (let y = 6; y < 10; y += 1) for (let x = 0; x < 6; x += 1) alpha[y * size + x] = 255
    const imageGeometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()

    const incoming = scene.spawnFromEntrance(makeDefinition('image', 'large-asymmetric-png', {
      visual: 'image', imageGeometry, useImageOutline: true, radius: 40,
    }))!
    expect(incoming.body.bounds.min.x).toBeGreaterThanOrEqual(ARENA_NECK.left + 10 - 0.01)
    expect(incoming.body.bounds.max.x).toBeLessThanOrEqual(ARENA_NECK.right - 10 + 0.01)
    expect(incoming.body.position.y + 40).toBeLessThan(0)
    expect(incoming.body.parts).toHaveLength(1)
    scene.destroy()
  })

  it('retains an enlarged irregular PNG collision shell inside the bowl', () => {
    const size = 24
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - 12) / 9
        const dy = (y + 0.5 - 14) / 8
        if (dx * dx + dy * dy < 1 || (y < 12 && (x < 8 || x > 15))) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    const object = scene.spawnFromEntrance(makeDefinition('image', 'irregular-cat-outline', {
      radius: 38, imageGeometry: geometry, useImageOutline: true, mass: 1,
    }))!

    for (let frame = 0; frame < 1800; frame += 1) scene.step(1000 / 60)
    expect(object.body.position.y).toBeLessThan(ARENA_CENTER.y + ARENA_RADIUS + 30)
    expect(object.body.position.y).toBeLessThan(SCENE_HEIGHT - 80)
    scene.destroy()
  }, 30000)

  it('keeps an entered object from escaping back through the open entrance', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    const incoming = scene.spawnFromEntrance(makeDefinition('image', 'returning-image', { radius: 24, visual: 'image' }))!

    // Let the entire body pass the inlet gate before testing an upward impact.
    for (let index = 0; index < 120 && ((incoming.body.collisionFilter.mask ?? 0) & 0x0002) === 0; index += 1) {
      scene.step(1000 / 60)
    }
    expect(incoming.body.position.y).toBeGreaterThanOrEqual(ARENA_NECK.top)
    expect((incoming.body.collisionFilter.mask ?? 0) & 0x0002).not.toBe(0)

    // Launch it upward from just below the hidden one-way gate. It must be
    // caught by a real Matter wall contact instead of being teleported back.
    Body.setPosition(incoming.body, { x: ARENA_CENTER.x + 35, y: ARENA_NECK.top + 32 })
    Body.setVelocity(incoming.body, { x: 2, y: -14 })
    let peakFrameDisplacement = 0
    for (let index = 0; index < 12; index += 1) {
      const before = { x: incoming.body.position.x, y: incoming.body.position.y }
      scene.step(1000 / 60)
      peakFrameDisplacement = Math.max(peakFrameDisplacement,
        Math.hypot(incoming.body.position.x - before.x, incoming.body.position.y - before.y))
    }

    expect(scene.engine.world.bodies).toContain(incoming.body)
    expect(incoming.body.position.y).toBeGreaterThan(ARENA_NECK.top + 3)
    expect(incoming.body.position.x).toBeLessThan(ARENA_NECK.right - 24)
    expect(peakFrameDisplacement).toBeLessThan(18)
    scene.destroy()
  })

  it('keeps circular PNG physics shells inside the lower bowl', () => {
    const size = 32
    const alpha = new Uint8Array(size * size)
    const insideTriangle = (x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      const area = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
      const first = area(x, y, ax, ay, bx, by)
      const second = area(x, y, bx, by, cx, cy)
      const third = area(x, y, cx, cy, ax, ay)
      return (first >= 0 && second >= 0 && third >= 0) || (first <= 0 && second <= 0 && third <= 0)
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const px = x + 0.5
        const py = y + 0.5
        const dx = (px - 16) / 11
        const dy = (py - 19) / 11
        const face = dx * dx + dy * dy < 1
        const ears = insideTriangle(px, py, 4, 14, 7, 2, 14, 12) || insideTriangle(px, py, 18, 12, 25, 2, 28, 14)
        if (face || ears) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    const images = Array.from({ length: 8 }, (_, index) => scene.spawnFromEntrance(makeDefinition('image', `bowl-image-${index}`, {
      visual: 'image', radius: 24, imageGeometry: geometry,
    }))!)
    for (let index = 0; index < 1800; index += 1) scene.step(1000 / 60)
    expect(images.every((image) => scene.engine.world.bodies.includes(image.body))).toBe(true)
    expect(Math.max(...images.map((image) => image.body.bounds.max.y))).toBeLessThan(ARENA_CENTER.y + ARENA_RADIUS + 20)
    scene.destroy()
  })

  it('keeps two touching uploaded PNGs inside the bowl after they settle', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    const images = [0, 1].map((index) => scene.spawnFromEntrance(makeDefinition('image', `pair-in-bowl-${index}`, {
      radius: 24, mass: 1, restitution: DEFAULT_RESTITUTION,
    }))!)

    for (let index = 0; index < 1800; index += 1) scene.step(1000 / 60)

    expect(images.every(({ body }) => scene.engine.world.bodies.includes(body))).toBe(true)
    expect(images.every(({ body }) => body.bounds.max.y < ARENA_CENTER.y + ARENA_RADIUS + 20)).toBe(true)
    expect(images.every(({ body }) => body.bounds.min.y > ARENA_NECK.top - 40)).toBe(true)
    expect(Math.max(...images.map(({ body }) => body.speed))).toBeLessThan(3.5)
    scene.destroy()
  })

  it('keeps PNG physics as one circular body during dense high-speed frames', () => {
    const size = 48
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - 24) / 18
        const dy = (y + 0.5 - 28) / 16
        if (dx * dx + dy * dy < 1 || (y < 18 && x > 6 && x < 14) || (y < 18 && x > 34 && x < 42)) {
          alpha[y * size + x] = 255
        }
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    scene.updateSettings({ gravity: 2.5, restitution: 1, speed: 2 })
    const images = Array.from({ length: 48 }, (_, index) => {
      const theta = index * 2.399
      const radial = 20 + (index % 4) * 11
      const x = ARENA_CENTER.x + Math.cos(theta) * radial
      const y = 130 + (index % 8) * 28
      return scene.addObject(makeDefinition('image', `stress-${index}`, {
        visual: 'image', radius: 32, imageGeometry: geometry, restitution: 1, density: 0.002,
      }), x, y)!
    })

    for (let frame = 0; frame < 6; frame += 1) {
      // A delayed render frame exercises the bounded substeps too (max
      // supported speed is 2×; max accepted frame delta is 50ms).
      scene.step(50)
      for (const image of images) {
        expect(scene.engine.world.bodies).toContain(image.body)
        expect(image.body.circleRadius).toBe(32)
        expect(Number.isFinite(image.body.position.x) && Number.isFinite(image.body.position.y)).toBe(true)
      }
    }
    scene.destroy()
  })

  it('uses Matter wall contacts to stop a fast PNG before it crosses the lower arena boundary', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    const image = scene.addObject(makeDefinition('image', 'tunneled-image', {
      visual: 'image', radius: 24,
    }), 180, ARENA_CENTER.y + ARENA_RADIUS - 50)!
    Body.setVelocity(image.body, { x: 0, y: 14 })

    for (let index = 0; index < 30; index += 1) scene.step(1000 / 60)

    expect(scene.engine.world.bodies).toContain(image.body)
    expect(image.body.position.y).toBeLessThan(ARENA_CENTER.y + ARENA_RADIUS + 24)
    expect(image.body.velocity.y).toBeLessThan(14)
    scene.destroy()
  })

  it('stacks quick arrivals above the entrance without overlapping their physics shells', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    const first = scene.spawnFromEntrance(makeDefinition('image', 'first', { radius: 24 }))!
    const second = scene.spawnFromEntrance(makeDefinition('image', 'second', { radius: 24 }))!
    expect(first.body.position.y - second.body.position.y).toBeGreaterThanOrEqual(60)
    expect(second.body.position.y + 24).toBeLessThan(first.body.position.y - 24)
    scene.destroy()
  })

  it('applies gravity and updates existing bodies', () => {
    const scene = new SimulationScene()
    const ball = scene.addObject(makeDefinition('circle', 'test-ball'), 180, 80)!
    scene.updateSettings({ gravity: 1.6 })
    for (let i = 0; i < 60; i += 1) scene.step(1000 / 60)
    expect(ball.body.position.y).toBeGreaterThan(80)
    expect(scene.engine.gravity.y).toBe(1.6)
    scene.destroy()
  })

  it('updates damping on existing bodies and recovers stale hot-reload settings', () => {
    const scene = new SimulationScene()
    const ball = scene.addObject(makeDefinition('circle', 'damping-test'), 180, 80)!
    ball.body.frictionAir = 0.001

    scene.updateSettings({ gravity: 1.1 })
    expect(ball.body.frictionAir).toBe(0.025)

    ball.body.frictionAir = 0.001
    scene.step(1000 / 60)
    expect(ball.body.frictionAir).toBe(0.025)
    scene.destroy()
  })

  it('preserves PNG travel at half speed instead of mistaking it for solver correction', () => {
    const size = 32
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - size / 2) / 12
        const dy = (y + 0.5 - size / 2) / 12
        if (dx * dx + dy * dy < 1) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0, speed: 0.5 })
    const image = scene.addObject(makeDefinition('image', 'half-speed-image', {
      radius: 24, imageGeometry: geometry,
    }), 180, 250)!
    expect(image.body.circleRadius).toBe(24)
    Body.setVelocity(image.body, { x: 1, y: 0 })
    const beforeX = image.body.position.x

    scene.step(1000 / 60)

    const actualDisplacement = image.body.position.x - beforeX
    // Body.velocity is normalized to Matter's base frame; account for the
    // total scene time scale, not just the final 240Hz internal substep.
    const expectedDisplacement = image.body.velocity.x * scene.settings.speed
    expect(Math.abs(actualDisplacement - expectedDisplacement)).toBeLessThan(0.01)
    expect(actualDisplacement).toBeGreaterThan(0.45)
    expect(actualDisplacement).toBeLessThan(0.55)
    scene.destroy()
  })

  it('uses calm defaults and settles a dense pile without runaway bouncing', () => {
    const scene = new SimulationScene()
    scene.initializeArena()
    expect(scene.settings.restitution).toBe(DEFAULT_RESTITUTION)
    expect(makeDefinition('circle', 'default-bounce').restitution).toBe(DEFAULT_RESTITUTION)
    expect(makeDefinition('image', 'default-image-bounce').restitution).toBe(DEFAULT_RESTITUTION)

    // A crowded but non-overlapping stack reproduces the user's high-object
    // count case, then gives the pile enough time to settle under gravity.
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        scene.addObject(makeDefinition('circle', `dense-${row}-${column}`, { radius: 9 }),
          111 + column * 20, 155 + row * 20)
      }
    }
    for (let frame = 0; frame < 900; frame += 1) scene.step(1000 / 60)

    const maxSettledSpeed = Math.max(...scene.objects.map(({ body }) => body.speed))
    expect(Number.isFinite(maxSettledSpeed)).toBe(true)
    expect(maxSettledSpeed).toBeLessThan(3)
    scene.destroy()
  })

  it('settles a dense pile of uploaded PNG physics shells', () => {
    const size = 32
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - 16) / 12
        const dy = (y + 0.5 - 16) / 12
        if (dx * dx + dy * dy < 1) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        scene.addObject(makeDefinition('image', `dense-png-${row}-${column}`, {
          radius: 14, imageGeometry: geometry, restitution: DEFAULT_RESTITUTION,
        }), 120 + column * 30, 145 + row * 30)
      }
    }
    for (let frame = 0; frame < 900; frame += 1) scene.step(1000 / 60)

    const maxSettledSpeed = Math.max(...scene.objects.map(({ body }) => body.speed))
    expect(Number.isFinite(maxSettledSpeed)).toBe(true)
    expect(maxSettledSpeed).toBeLessThan(3.5)
    scene.destroy()
  })

  it('keeps a crowded pile of irregular uploaded PNG shells from sustaining high speeds', () => {
    const size = 48
    const alpha = new Uint8Array(size * size)
    const inTriangle = (x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
        (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
      const a = cross(x, y, ax, ay, bx, by)
      const b = cross(x, y, bx, by, cx, cy)
      const c = cross(x, y, cx, cy, ax, ay)
      return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - 24) / 16
        const dy = (y + 0.5 - 29) / 15
        if (dx * dx + dy * dy < 1 ||
            inTriangle(x + 0.5, y + 0.5, 7, 21, 13, 2, 22, 17) ||
            inTriangle(x + 0.5, y + 0.5, 26, 17, 35, 2, 41, 21)) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        scene.addObject(makeDefinition('image', `crowded-cat-${row}-${column}`, {
          radius: 18, mass: 1, imageGeometry: geometry, restitution: DEFAULT_RESTITUTION,
        }), 130 + column * 20, 160 + row * 27)
      }
    }
    for (let frame = 0; frame < 1800; frame += 1) scene.step(1000 / 60)

    const maxSettledSpeed = Math.max(...scene.objects.map(({ body }) => body.speed))
    expect(maxSettledSpeed).toBeLessThan(3.5)
    scene.destroy()
  })

  it('limits peak speed when a crowded PNG scene is filled through the real entrance', () => {
    const size = 32
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - 16) / 11
        const dy = (y + 0.5 - 20) / 10
        if (dx * dx + dy * dy < 1 || (y < 15 && (x < 11 || x > 20))) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.initializeArena()
    let peakSpeed = 0
    let peakSpeedDetails: unknown
    let peakAngleStep = 0
    let peakSolverCorrection = 0
    let peakStepDetails: unknown
    const originalPostSolvePosition = Matter.Resolver.postSolvePosition
    Matter.Resolver.postSolvePosition = (bodies) => {
      const before = new Map(bodies.map((body) => [body.id, { x: body.position.x, y: body.position.y }]))
      originalPostSolvePosition(bodies)
      for (const body of bodies) {
        const start = before.get(body.id)!
        const correction = Math.hypot(body.position.x - start.x, body.position.y - start.y)
        if (correction > peakSolverCorrection) {
          peakSolverCorrection = correction
          peakStepDetails = {
            id: body.id, label: body.label, correction,
            impulse: { ...(body as Matter.Body & { positionImpulse?: { x: number; y: number } }).positionImpulse },
            contacts: (scene.engine.pairs.list as Matter.Pair[]).filter((pair: Matter.Pair) => pair.isActive && (pair.bodyA.parent.id === body.id || pair.bodyB.parent.id === body.id)).map((pair: Matter.Pair) => ({
              a: pair.bodyA.parent.label, b: pair.bodyB.parent.label, depth: pair.collision.depth, separation: pair.separation,
            })),
          }
        }
      }
    }
    try {
      for (let frame = 0; frame < 3600; frame += 1) {
        if (frame % 30 === 0 && scene.objects.length < 48) {
          scene.spawnFromEntrance(makeDefinition('image', `entrance-stress-${frame}`, {
            // 48 px is the editor's default PNG diameter; exercising that size
            // matters because its crowding pressure is much higher than the
            // smaller 32 px fixtures used in the original stream test.
            radius: 24, mass: 1, imageGeometry: geometry, restitution: DEFAULT_RESTITUTION,
          }))
        }
        const previous = scene.objects.map(({ body }) => ({ angle: body.angle }))
        scene.step(1000 / 60)
        scene.objects.forEach(({ body }, index) => {
          peakAngleStep = Math.max(peakAngleStep, Math.abs(body.angle - previous[index]!.angle))
          if (body.speed > peakSpeed) {
            peakSpeed = body.speed
            peakSpeedDetails = { frame, index, position: { ...body.position }, velocity: { ...body.velocity } }
          }
        })
      }
    } finally {
      Matter.Resolver.postSolvePosition = originalPostSolvePosition
    }
    const finalMaxSpeed = Math.max(...scene.objects.map(({ body }) => body.speed))
    expect(scene.objects).toHaveLength(48)
    // Peak speed includes the uninterrupted fall through the inlet; the
    // low-restitution pair test below specifically guards collision bounce.
    // Incoming objects keep enough momentum to feel natural, while the bound
    // rejects solver impulses that are much faster than their gravity-driven
    // fall through the chute.
    expect(peakSpeed, JSON.stringify(peakSpeedDetails)).toBeLessThan(10)
    expect(finalMaxSpeed).toBeLessThan(1)
    // Reject solver-only teleports while allowing the object's real velocity
    // to carry it naturally through the inlet.
    expect(peakSolverCorrection, JSON.stringify(peakStepDetails)).toBeLessThan(2)
    expect(peakAngleStep, `peak angle step ${peakAngleStep}`).toBeLessThan(0.12)
    scene.destroy()
  })

  it('keeps falling objects inside the floor and respects max object count', () => {
    const scene = new SimulationScene()
    const ball = scene.addObject(makeDefinition('circle', 'floor-test'), 180, 600)!
    for (let i = 0; i < 360; i += 1) scene.step(1000 / 60)
    expect(ball.body.position.y).toBeLessThan(630)
    for (let i = 0; i < MAX_OBJECTS + 10; i += 1) scene.create('circle')
    expect(scene.objects).toHaveLength(MAX_OBJECTS)
    scene.destroy()
  })

  it('uses collision elasticity for two moving balls', () => {
    const scene = new SimulationScene()
    const first = scene.addObject(makeDefinition('circle', 'one', { radius: 16, restitution: 1 }), 140, 250)!
    const second = scene.addObject(makeDefinition('circle', 'two', { radius: 16, restitution: 1 }), 210, 250)!
    Body.setVelocity(first.body, { x: 5, y: 0 })
    Body.setVelocity(second.body, { x: -5, y: 0 })
    // Check immediately after contact so the test measures collision
    // elasticity, not later rebounds from the sandbox's outer walls.
    for (let i = 0; i < 8; i += 1) scene.step(1000 / 60)
    expect(first.body.velocity.x).toBeLessThan(0)
    expect(second.body.velocity.x).toBeGreaterThan(0)
    scene.destroy()
  })

  it('keeps default object-to-object collisions nearly inelastic', () => {
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const first = scene.addObject(makeDefinition('circle', 'calm-one', { radius: 16 }), 140, 250)!
    const second = scene.addObject(makeDefinition('circle', 'calm-two', { radius: 16 }), 180, 250)!
    Body.setVelocity(first.body, { x: 5, y: 0 })
    Body.setVelocity(second.body, { x: -5, y: 0 })

    for (let index = 0; index < 4; index += 1) scene.step(1000 / 60)

    expect(first.body.velocity.x).toBeLessThan(0)
    expect(second.body.velocity.x).toBeGreaterThan(0)
    expect(Math.max(first.body.speed, second.body.speed)).toBeLessThan(0.5)
    scene.destroy()
  })

  it('preserves a gentle, nearly inelastic impulse on a light object touch', () => {
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const incoming = scene.addObject(makeDefinition('circle', 'soft-touch-incoming', { radius: 16 }), 140, 250)!
    const resting = scene.addObject(makeDefinition('circle', 'soft-touch-resting', { radius: 16 }), 172, 250)!
    Body.setVelocity(incoming.body, { x: 0.05, y: 0 })

    let contactSeen = false
    let contactVelocities: { incoming: number; resting: number } | undefined
    scene.setCollisionListener((a, b) => {
      if (new Set([a.definition.id, b.definition.id]).has('soft-touch-incoming') &&
          new Set([a.definition.id, b.definition.id]).has('soft-touch-resting')) contactSeen = true
    })
    for (let frame = 0; frame < 60; frame += 1) {
      scene.step(1000 / 60)
      if (contactSeen && !contactVelocities) {
        contactVelocities = { incoming: incoming.body.velocity.x, resting: resting.body.velocity.x }
      }
    }

    expect(contactSeen).toBe(true)
    expect(contactVelocities).toBeDefined()
    // Equal-mass, low-speed contact should share the motion instead of
    // launching the bodies apart or deleting most of their momentum.
    expect(contactVelocities!.incoming).toBeGreaterThan(-0.005)
    expect(contactVelocities!.resting).toBeGreaterThan(0.01)
    expect(contactVelocities!.resting).toBeLessThan(0.04)
    expect(Math.abs(contactVelocities!.incoming - contactVelocities!.resting)).toBeLessThan(0.01)
    scene.destroy()
  })

  it('lets a glancing touch create a small natural rotation without a hard bounce', () => {
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const incoming = scene.addObject(makeDefinition('circle', 'glancing-incoming', { radius: 16 }), 140, 250)!
    const resting = scene.addObject(makeDefinition('circle', 'glancing-resting', { radius: 16 }), 171, 258)!
    Body.setVelocity(incoming.body, { x: 0.4, y: 0 })

    for (let frame = 0; frame < 8; frame += 1) scene.step(1000 / 60)

    expect(Math.max(incoming.body.speed, resting.body.speed)).toBeLessThan(0.5)
    expect(Math.max(Math.abs(incoming.body.angularVelocity), Math.abs(resting.body.angularVelocity)))
      .toBeGreaterThan(0.0005)
    scene.destroy()
  })

  it('softens a barely touching compound PNG pair without losing its shared impulse', () => {
    const size = 32
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - size / 2) / 13
        const dy = (y + 0.5 - size / 2) / 13
        if (dx * dx + dy * dy < 1) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const incoming = scene.addObject(makeDefinition('image', 'png-soft-touch-incoming', {
      radius: 24, mass: 1, imageGeometry: geometry,
    }), 140, 250)!
    const resting = scene.addObject(makeDefinition('image', 'png-soft-touch-resting', {
      radius: 24, mass: 1, imageGeometry: geometry,
    }), 210, 250)!
    const incomingRight = incoming.body.bounds.max.x - incoming.body.position.x
    const restingLeft = resting.body.position.x - resting.body.bounds.min.x
    Body.setPosition(incoming.body, {
      x: resting.body.position.x - restingLeft - incomingRight - 0.1,
      y: incoming.body.position.y,
    })
    Body.setVelocity(incoming.body, { x: 0.05, y: 0 })

    let contactSeen = false
    let firstContact: { incomingX: number; restingX: number } | undefined
    scene.setCollisionListener((a, b) => {
      if (new Set([a.definition.id, b.definition.id]).has(incoming.definition.id) &&
          new Set([a.definition.id, b.definition.id]).has(resting.definition.id)) contactSeen = true
    })
    for (let frame = 0; frame < 40 && !firstContact; frame += 1) {
      scene.step(1000 / 60)
      if (contactSeen) firstContact = { incomingX: incoming.body.velocity.x, restingX: resting.body.velocity.x }
    }

    expect(contactSeen).toBe(true)
    expect(firstContact).toBeDefined()
    expect(firstContact!.incomingX).toBeGreaterThan(0)
    expect(firstContact!.restingX).toBeGreaterThan(0.01)
    expect(firstContact!.restingX).toBeLessThan(0.04)
    expect(Math.abs(firstContact!.incomingX + firstContact!.restingX - 0.05)).toBeLessThan(0.01)
    expect(Math.abs(firstContact!.incomingX - firstContact!.restingX)).toBeLessThan(0.005)
    scene.destroy()
  })

  it('does not pull barely touching PNG bodies into each other during position solving', () => {
    const size = 48
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - size / 2) / 19
        const dy = (y + 0.5 - size / 2) / 19
        if (dx * dx + dy * dy < 1) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const first = scene.addObject(makeDefinition('image', 'png-micro-touch-left', {
      radius: 24, mass: 1, imageGeometry: geometry,
    }), 100, 250)!
    const second = scene.addObject(makeDefinition('image', 'png-micro-touch-right', {
      radius: 24, mass: 1, imageGeometry: geometry,
    }), 200, 250)!
    const firstExtent = first.body.bounds.max.x - first.body.position.x
    const secondExtent = second.body.position.x - second.body.bounds.min.x
    Body.setPosition(second.body, {
      x: first.body.position.x + firstExtent + secondExtent - 0.1,
      y: second.body.position.y,
    })
    const beforeFirstX = first.body.position.x
    const beforeSecondX = second.body.position.x

    scene.step(1000 / 60)

    // There is no incoming velocity here, so movement is the position
    // solver's correction alone. A correction in the wrong direction is the
    // inward pull that causes a visible snap on the next solver iteration.
    const firstCorrection = first.body.position.x - beforeFirstX
    const secondCorrection = second.body.position.x - beforeSecondX
    expect(scene.engine.pairs.list.some((pair: Matter.Pair) =>
      (pair.collision.parentA === first.body && pair.collision.parentB === second.body) ||
      (pair.collision.parentA === second.body && pair.collision.parentB === first.body))).toBe(true)
    // At a shallow 0.1 px overlap, any corrective movement should be outward
    // and remain local. Large positive/negative corrections are the visible
    // plastic-looking snap reported in dense PNG scenes.
    expect(firstCorrection).toBeLessThan(0)
    expect(secondCorrection).toBeGreaterThan(0)
    expect(Math.abs(firstCorrection)).toBeLessThan(0.1)
    expect(Math.abs(secondCorrection)).toBeLessThan(0.1)
    scene.destroy()
  })

  it('uses a single Matter contact manifold for circular PNG shells', () => {
    const size = 48
    const alpha = new Uint8Array(size * size)
    const insideTriangle = (x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
      const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
        (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
      const a = cross(x, y, ax, ay, bx, by)
      const b = cross(x, y, bx, by, cx, cy)
      const c = cross(x, y, cx, cy, ax, ay)
      return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const px = x + 0.5
        const py = y + 0.5
        const dx = (px - 24) / 17
        const dy = (py - 31) / 15
        const face = dx * dx + dy * dy < 1
        const tufts = insideTriangle(px, py, 4, 24, 10, 3, 17, 20) ||
          insideTriangle(px, py, 13, 20, 21, 0, 26, 19) ||
          insideTriangle(px, py, 27, 20, 36, 2, 41, 23)
        if (face || tufts) alpha[y * size + x] = 255
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const left = scene.addObject(makeDefinition('image', 'manifold-png-left', {
      radius: 24, imageGeometry: geometry,
    }), 140, 250)!
    const right = scene.addObject(makeDefinition('image', 'manifold-png-right', {
      radius: 24, imageGeometry: geometry,
    }), 179, 250)!
    const leftExtent = left.body.bounds.max.x - left.body.position.x
    const rightExtent = right.body.position.x - right.body.bounds.min.x
    const rawDetector = Matter.Detector.create({ bodies: [left.body, right.body] })

    // A small, deliberate overlap confirms alpha-mask complexity does not
    // create additional physical fixtures or contact manifolds.
    Body.setPosition(right.body, {
      x: left.body.position.x + leftExtent + rightExtent - 4,
      y: left.body.position.y,
    })
    const rawContactCount = Matter.Detector.collisions(rawDetector).length
    Matter.Detector.setBodies(scene.engine.detector, [left.body, right.body])
    const filteredContactCount = Matter.Detector.collisions(scene.engine.detector).length

    Body.setPosition(right.body, {
      x: left.body.position.x + leftExtent + rightExtent - 0.1,
      y: left.body.position.y,
    })
    Body.setVelocity(left.body, { x: 0.08, y: 0 })

    for (let frame = 0; frame < 6; frame += 1) scene.step(1000 / 60)
    const contacts = scene.engine.pairs.list.filter((pair: Matter.Pair) =>
      pair.collision.parentA === left.body && pair.collision.parentB === right.body ||
      pair.collision.parentA === right.body && pair.collision.parentB === left.body)

    expect(geometry.parts.length).toBeGreaterThan(8)
    expect(rawContactCount).toBe(1)
    expect(filteredContactCount).toBe(1)
    expect(contacts).toHaveLength(1)
    expect(left.body.speed).toBeLessThan(0.1)
    expect(right.body.speed).toBeLessThan(0.1)
    expect(Math.abs(left.body.angularVelocity)).toBeLessThan(0.005)
    expect(Math.abs(right.body.angularVelocity)).toBeLessThan(0.005)
    Matter.Detector.clear(rawDetector)
    scene.destroy()
  })

  it('limits contact-speed propagation through a non-overlapping set of 60 PNG objects', () => {
    const size = 48
    const alpha = new Uint8Array(size * size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (x + 0.5 - 24) / 16
        const dy = (y + 0.5 - 29) / 15
        if (dx * dx + dy * dy < 1 ||
            (y < 20 && ((x - 12) ** 2 + (y - 12) ** 2 < 64 || (x - 36) ** 2 + (y - 12) ** 2 < 64))) {
          alpha[y * size + x] = 255
        }
      }
    }
    const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
    const scene = new SimulationScene()
    scene.updateSettings({ gravity: 0 })
    const images: SceneObject[] = []
    const columns = 6
    const pitchX = 50
    const pitchY = 50
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (images.length >= 60) break
        images.push(scene.addObject(makeDefinition('image', `soft-png-${row}-${column}`, {
          radius: 24, mass: 1, restitution: DEFAULT_RESTITUTION, imageGeometry: geometry,
        }), 30 + column * pitchX, 40 + row * pitchY)!)
      }
    }
    const incoming = images[4 * columns + 2]!
    const firstNeighbor = images[4 * columns + 3]!
    // Bring only this pair close enough to touch. All other neighbors retain
    // a wide gap, so this 60-object scene cannot turn the measured tap into a
    // domino chain or contain pre-existing overlaps.
    const incomingRightExtent = incoming.body.bounds.max.x - incoming.body.position.x
    const neighborLeftExtent = firstNeighbor.body.position.x - firstNeighbor.body.bounds.min.x
    Body.setPosition(incoming.body, {
      x: firstNeighbor.body.position.x - neighborLeftExtent - incomingRightExtent - 1,
      y: incoming.body.position.y,
    })
    const initialOverlapCount = images.reduce((count, image, index) =>
      count + Query.collides(image.body, images.slice(index + 1).map((other) => other.body)).length, 0)
    expect(initialOverlapCount).toBe(0)
    Body.setVelocity(incoming.body, { x: 0.6, y: 0 })
    let contactSeen = false
    scene.setCollisionListener((a, b) => {
      if (new Set([a.definition.id, b.definition.id]).has(incoming.definition.id) &&
          new Set([a.definition.id, b.definition.id]).has(firstNeighbor.definition.id)) {
        contactSeen = true
      }
    })

    let maxNeighborSpeed = 0
    let maxFirstNeighborSpeed = 0
    let firstContactVelocities: { incoming: number; neighbor: number } | undefined
    let maxNeighborFrameDisplacement = 0
    let maxPostContactNeighborDisplacement = 0
    let maxNeighborFrameAngle = 0
    let contactFrame = -1
    let worstPostContactNeighbor: { frame: number; index: number; displacement: number; speed: number; angle: number } | undefined
    for (let frame = 0; frame < 90; frame += 1) {
      const contactBeforeStep = contactSeen
      const previous = images.map(({ body }) => ({ x: body.position.x, y: body.position.y, angle: body.angle }))
      scene.step(1000 / 60)
      if (!contactBeforeStep && contactSeen) {
        firstContactVelocities = {
          incoming: incoming.body.velocity.x,
          neighbor: firstNeighbor.body.velocity.x,
        }
        contactFrame = frame
      }
      images.forEach(({ body }, index) => {
        if (index === images.indexOf(incoming)) return
        const before = previous[index]!
        const displacement = Math.hypot(body.position.x - before.x, body.position.y - before.y)
        maxNeighborFrameDisplacement = Math.max(maxNeighborFrameDisplacement, displacement)
        // The first touch may need one sub-pixel Matter penetration repair.
        // The user-visible jitter is repeated movement after that correction.
        if (contactFrame >= 0 && frame > contactFrame) {
          if (displacement > maxPostContactNeighborDisplacement) {
            maxPostContactNeighborDisplacement = displacement
            worstPostContactNeighbor = { frame, index, displacement, speed: body.speed, angle: body.angle }
          }
        }
        maxNeighborFrameAngle = Math.max(maxNeighborFrameAngle, Math.abs(body.angle - before.angle))
      })
      maxFirstNeighborSpeed = Math.max(maxFirstNeighborSpeed, firstNeighbor.body.speed)
      maxNeighborSpeed = Math.max(maxNeighborSpeed,
        ...images.filter((image) => image !== incoming).map((image) => image.body.speed))
    }

    expect(images).toHaveLength(60)
    expect(contactSeen).toBe(true)
    // PNG fixtures are compound bodies, so the transfer is not exactly the
    // 50/50 circle result. It must still be a soft shared push, not a bounce
    // or the old per-frame velocity wipe used by the previous implementation.
    expect(firstContactVelocities).toBeDefined()
    expect(firstContactVelocities!.incoming).toBeGreaterThan(0)
    expect(firstContactVelocities!.neighbor).toBeGreaterThan(0.1)
    expect(firstContactVelocities!.neighbor).toBeLessThan(0.4)
    expect(Math.abs(firstContactVelocities!.incoming - firstContactVelocities!.neighbor)).toBeLessThan(0.2)
    expect(maxFirstNeighborSpeed).toBeLessThan(0.6)
    expect(maxNeighborSpeed).toBeLessThan(1.2)
    expect(maxNeighborFrameDisplacement).toBeLessThan(1.2)
    expect(maxPostContactNeighborDisplacement, JSON.stringify(worstPostContactNeighbor)).toBeLessThan(1.2)
    expect(maxNeighborFrameAngle).toBeLessThan(0.02)
    scene.destroy()
  })

  it('builds the bounded demo with a moving static platform', () => {
    const scene = new SimulationScene()
    scene.createDemo(6)
    const platform = scene.objects.find((item) => item.definition.motion?.type === 'oscillate-x')!
    const startX = platform.body.position.x
    expect(platform.body.isStatic).toBe(true)
    expect(scene.objects).toHaveLength(7)
    for (let i = 0; i < 24; i += 1) scene.step(1000 / 60)
    expect(platform.body.position.x).not.toBe(startX)
    scene.destroy()
  })

  it('updates mass and size without replacing the physics body', () => {
    const scene = new SimulationScene()
    const ball = scene.addObject(makeDefinition('circle', 'editable'), 180, 100)!
    const bodyId = ball.body.id
    scene.updateObject('editable', { radius: 30, mass: 2 })
    expect(ball.body.id).toBe(bodyId)
    expect(ball.body.mass).toBe(2)
    expect(ball.definition.radius).toBe(30)
    scene.destroy()
  })

  it('resizes rectangular obstacles independently on each axis', () => {
    const scene = new SimulationScene()
    const platform = scene.create('box', 180, 300, { width: 80, height: 12 })!
    scene.updateObject(platform.definition.id, { width: 120 })
    expect(platform.body.bounds.max.x - platform.body.bounds.min.x).toBeCloseTo(120, 0)
    expect(platform.body.bounds.max.y - platform.body.bounds.min.y).toBeCloseTo(12, 0)
    scene.destroy()
  })

  it('supports a custom registered kind without changing the scene core', () => {
    const testKind = 'test-diamond' as ObjectKind
    registerObjectTemplate(testKind, { kind: testKind, visual: 'polygon', label: 'Test', color: 0xffffff, radius: 12, sides: 4 })
    registerPhysicsBodyFactory(testKind, (_definition, x, y, options) => Matter.Bodies.polygon(x, y, 4, 12, options))
    const scene = new SimulationScene()
    const object = scene.create(testKind)!
    expect(object.definition.visual).toBe('polygon')
    expect(object.body.position.x).toBe(180)
    scene.destroy()
  })
})
