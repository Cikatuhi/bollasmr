import Matter from 'matter-js'
import type { ObjectDefinition, ObjectKind } from '../objects/definitions'

export type PhysicsBodyFactory = (definition: ObjectDefinition, x: number, y: number, options: Matter.IBodyDefinition) => Matter.Body

const factories = new Map<ObjectKind, PhysicsBodyFactory>()

export function registerPhysicsBodyFactory(kind: ObjectKind, factory: PhysicsBodyFactory) {
  factories.set(kind, factory)
}

export function createPhysicsBody(definition: ObjectDefinition, x: number, y: number, options: Matter.IBodyDefinition) {
  const factory = factories.get(definition.kind)
  if (!factory) throw new Error(`Не зарегистрирована физическая оболочка для типа «${definition.kind}».`)
  return factory(definition, x, y, options)
}

/**
 * Matter.js 0.20 omits the parallel-axis term for fixtures in a compound
 * body's inertia. Recompute from the child fixtures so this is safe to call
 * after resizing or changing the parent body's mass (and never accumulates).
 */
export function correctCompoundInertia(body: Matter.Body) {
  if (body.parts.length <= 1 || body.isStatic) return

  const fixtures = body.parts.slice(1)
  const fixtureMass = fixtures.reduce((sum, part) => sum + part.mass, 0)
  if (!Number.isFinite(fixtureMass) || fixtureMass <= 0) return

  const fixtureInertia = fixtures.reduce((sum, part) => sum + part.inertia, 0)
  const parallelAxisInertia = fixtures.reduce((sum, part) => {
    const offsetX = part.position.x - body.position.x
    const offsetY = part.position.y - body.position.y
    return sum + part.mass * (offsetX * offsetX + offsetY * offsetY)
  }, 0)
  const bodyInternals = Matter.Body as typeof Matter.Body & { _inertiaScale?: number }
  const inertiaScale = bodyInternals._inertiaScale ?? 4

  // Body.setMass() scales inertia linearly by mass while leaving part masses
  // unchanged, so match its ratio using the sum of the current fixture masses.
  Matter.Body.setInertia(body,
    ((fixtureInertia + inertiaScale * parallelAxisInertia) * body.mass) / fixtureMass)
}

registerPhysicsBodyFactory('circle', (definition, x, y, options) => Matter.Bodies.circle(x, y, definition.radius ?? 20, options, 18))
// Uploaded PNGs render with their original proportions, while their physical
// shell stays deliberately simple and stable: one circle per image.
registerPhysicsBodyFactory('image', (definition, x, y, options) =>
  Matter.Bodies.circle(x, y, definition.radius ?? 24, options, 24))
registerPhysicsBodyFactory('polygon', (definition, x, y, options) => Matter.Bodies.polygon(x, y, Math.max(3, definition.sides ?? 3), definition.radius ?? 22, options))
registerPhysicsBodyFactory('box', (definition, x, y, options) => Matter.Bodies.rectangle(x, y, definition.width ?? 80, definition.height ?? 12, options))
