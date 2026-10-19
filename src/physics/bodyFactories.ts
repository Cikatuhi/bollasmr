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

registerPhysicsBodyFactory('circle', (definition, x, y, options) => Matter.Bodies.circle(x, y, definition.radius ?? 20, options, 18))
// Matter.js does not combine an array of convex vertex sets into one filled
// concave body: it treats them as separate compound parts. That leaves gaps
// between alpha-mask cells where thin arena walls can pass through. Keep the
// PNG's transparent silhouette for rendering, but use one stable, continuous
// circular shell for collision response.
registerPhysicsBodyFactory('image', (definition, x, y, options) =>
  Matter.Bodies.circle(x, y, definition.radius ?? 24, options, 24))
registerPhysicsBodyFactory('polygon', (definition, x, y, options) => Matter.Bodies.polygon(x, y, Math.max(3, definition.sides ?? 3), definition.radius ?? 22, options))
registerPhysicsBodyFactory('box', (definition, x, y, options) => Matter.Bodies.rectangle(x, y, definition.width ?? 80, definition.height ?? 12, options))
