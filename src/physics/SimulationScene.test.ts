import { describe, expect, it } from 'vitest'
import Matter, { Body } from 'matter-js'
import { MAX_OBJECTS, SimulationScene } from './SimulationScene'
import { makeDefinition, registerObjectTemplate, type ObjectKind } from '../objects/definitions'
import { registerPhysicsBodyFactory } from './bodyFactories'

describe('SimulationScene', () => {
  it('applies gravity and updates existing bodies', () => {
    const scene = new SimulationScene()
    const ball = scene.addObject(makeDefinition('circle', 'test-ball'), 180, 80)!
    scene.updateSettings({ gravity: 1.6 })
    for (let i = 0; i < 60; i += 1) scene.step(1000 / 60)
    expect(ball.body.position.y).toBeGreaterThan(80)
    expect(scene.engine.gravity.y).toBe(1.6)
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
    for (let i = 0; i < 80; i += 1) scene.step(1000 / 60)
    expect(first.body.velocity.x).toBeLessThan(0)
    expect(second.body.velocity.x).toBeGreaterThan(0)
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
