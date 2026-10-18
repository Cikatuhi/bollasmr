import { it } from 'vitest'
import Matter, { Body } from 'matter-js'
import { SimulationScene } from './SimulationScene'
import { makeDefinition } from '../objects/definitions'
import { imageCollisionGeometryFromAlpha } from '../objects/imageCollisionGeometry'

it('diagnostic: shallow uneven PNG contact', () => {
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
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const px = x + 0.5
    const py = y + 0.5
    const dx = (px - 24) / 17
    const dy = (py - 31) / 15
    if (dx * dx + dy * dy < 1 ||
      inTriangle(px, py, 4, 24, 10, 3, 17, 20) ||
      inTriangle(px, py, 13, 20, 21, 0, 26, 19) ||
      inTriangle(px, py, 27, 20, 36, 2, 41, 23)) alpha[y * size + x] = 255
  }
  const geometry = imageCollisionGeometryFromAlpha(size, size, size, size, alpha)
  const scene = new SimulationScene()
  scene.updateSettings({ gravity: 0 })
  const left = scene.addObject(makeDefinition('image', 'diag-left', { radius: 24, mass: 1, imageGeometry: geometry }), 140, 250)!
  const right = scene.addObject(makeDefinition('image', 'diag-right', { radius: 24, mass: 1, imageGeometry: geometry }), 179, 250)!
  const extentA = left.body.bounds.max.x - left.body.position.x
  const extentB = right.body.position.x - right.body.bounds.min.x
  Body.setPosition(right.body, { x: left.body.position.x + extentA + extentB - 0.1, y: left.body.position.y })
  Body.setVelocity(left.body, { x: 0.05, y: 0 })
  let positionCorrections: Array<{ id: number; x: number; y: number; angle: number }> = []
  const originalPostSolvePosition = Matter.Resolver.postSolvePosition
  Matter.Resolver.postSolvePosition = (bodies) => {
    const before = new Map(bodies.map((body) => [body.id, { ...body.position, angle: body.angle }]))
    originalPostSolvePosition(bodies)
    positionCorrections = [left.body, right.body].map((body) => {
      const previous = before.get(body.id)!
      return { id: body.id, x: body.position.x - previous.x, y: body.position.y - previous.y, angle: body.angle - previous.angle }
    })
  }
  try { scene.step(1000 / 60) } finally { Matter.Resolver.postSolvePosition = originalPostSolvePosition }
  console.log(JSON.stringify({
    parts: geometry.parts.length,
    startGap: right.body.position.x - left.body.position.x - extentA - extentB,
    velocities: [left.body.velocity.x, right.body.velocity.x],
    truePositionSolverDelta: positionCorrections,
    pairs: scene.engine.pairs.list.map((pair: Matter.Pair) => ({
      normal: { ...pair.collision.normal }, depth: pair.collision.depth,
      supports: pair.collision.supports.map(({ x, y }: Matter.Vector) => ({ x, y })), parts: [pair.bodyA.id, pair.bodyB.id],
    })),
  }))
  scene.destroy()

  const crowd = new SimulationScene()
  crowd.updateSettings({ gravity: 0 })
  const background = Array.from({ length: 60 }, (_, index) => {
    const column = index % 6
    const row = Math.floor(index / 6)
    return crowd.addObject(makeDefinition('image', `crowd-${index}`, { radius: 24, mass: 1, imageGeometry: geometry }),
      42 + column * 54, 30 + row * 54)!
  })
  const tapA = crowd.addObject(makeDefinition('image', 'crowd-tap-a', { radius: 24, mass: 1, imageGeometry: geometry }), 120, 570)!
  const tapB = crowd.addObject(makeDefinition('image', 'crowd-tap-b', { radius: 24, mass: 1, imageGeometry: geometry }), 160, 570)!
  const tapRight = tapA.body.bounds.max.x - tapA.body.position.x
  const tapLeft = tapB.body.position.x - tapB.body.bounds.min.x
  Body.setPosition(tapB.body, { x: tapA.body.position.x + tapRight + tapLeft - 0.1, y: tapB.body.position.y })
  Body.setVelocity(tapA.body, { x: 0.05, y: 0 })
  let crowdCorrections: Array<{ id: number; x: number; y: number; angle: number }> = []
  const crowdPostSolvePosition = Matter.Resolver.postSolvePosition
  Matter.Resolver.postSolvePosition = (bodies) => {
    const before = new Map(bodies.map((body) => [body.id, { ...body.position, angle: body.angle }]))
    crowdPostSolvePosition(bodies)
    crowdCorrections = [tapA, tapB, ...background].map(({ body }) => {
      const previous = before.get(body.id)!
      return { id: body.id, x: body.position.x - previous.x, y: body.position.y - previous.y, angle: body.angle - previous.angle }
    })
  }
  try { crowd.step(1000 / 60) } finally { Matter.Resolver.postSolvePosition = crowdPostSolvePosition }
  console.log(JSON.stringify({
    crowdBodies: crowd.objects.length,
    tapVelocity: [tapA.body.velocity.x, tapB.body.velocity.x],
    correctionCount: crowdCorrections.filter(({ x, y, angle }) => Math.hypot(x, y, angle) > 1e-6).length,
    maxCorrection: Math.max(...crowdCorrections.map(({ x, y }) => Math.hypot(x, y))),
    tapCorrections: crowdCorrections.slice(0, 2),
    maxAngularCorrection: Math.max(...crowdCorrections.map(({ angle }) => Math.abs(angle))),
    activePairCount: crowd.engine.pairs.list.filter((pair: Matter.Pair) => pair.isActive).length,
  }))
  crowd.destroy()

  for (const offsetY of [-12, -8, -4, 4, 8, 12]) {
    const oblique = new SimulationScene()
    oblique.updateSettings({ gravity: 0 })
    const a = oblique.addObject(makeDefinition('image', `oblique-a-${offsetY}`, { radius: 24, mass: 1, imageGeometry: geometry }), 140, 250)!
    const b = oblique.addObject(makeDefinition('image', `oblique-b-${offsetY}`, { radius: 24, mass: 1, imageGeometry: geometry }), 200, 250 + offsetY)!
    let x = 200
    let collision = Matter.Query.collides(a.body, [b.body])
    while (collision.length === 0 && x > 140) {
      x -= 0.05
      Body.setPosition(b.body, { x, y: 250 + offsetY })
      collision = Matter.Query.collides(a.body, [b.body])
    }
    Body.setVelocity(a.body, { x: 0.05, y: 0 })
    let obliqueSolver: Array<{ x: number; y: number; angle: number }> = []
    const original = Matter.Resolver.postSolvePosition
    Matter.Resolver.postSolvePosition = (bodies) => {
      const before = new Map(bodies.map((body) => [body.id, { ...body.position, angle: body.angle }]))
      original(bodies)
      obliqueSolver = [a.body, b.body].map((body) => {
        const prev = before.get(body.id)!
        return { x: body.position.x - prev.x, y: body.position.y - prev.y, angle: body.angle - prev.angle }
      })
    }
    try { oblique.step(1000 / 60) } finally { Matter.Resolver.postSolvePosition = original }
    console.log(JSON.stringify({
      offsetY, x, initialDepth: collision[0]?.depth,
      velocity: [{ ...a.body.velocity }, { ...b.body.velocity }],
      angularVelocity: [a.body.angularVelocity, b.body.angularVelocity],
      angleStep: [a.body.angle, b.body.angle],
      solver: obliqueSolver,
    }))
    oblique.destroy()
  }
})
