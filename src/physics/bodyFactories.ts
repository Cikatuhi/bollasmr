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
// Uploaded PNGs render with their original proportions, while their physical
// shell stays deliberately simple and stable: one circle per image.
registerPhysicsBodyFactory('image', (definition, x, y, options) =>
  definition.useImageOutline ? createImageBody(definition, x, y, options) : Matter.Bodies.circle(x, y, definition.radius ?? 24, options, 24))

/** Build a bounded compound shell from the uploaded PNG's alpha geometry. */
function createImageBody(definition: ObjectDefinition, x: number, y: number, options: Matter.IBodyDefinition) {
  const geometry = definition.imageGeometry
  if (!geometry?.parts.length) return Matter.Bodies.circle(x, y, definition.radius ?? 24, options, 24)

  const diameter = (definition.radius ?? 24) * 2
  const parts = geometry.parts.map((part) => part.map((point) => ({
    x: x + point.x * diameter,
    y: y + point.y * diameter,
  })))
  try {
    return Matter.Bodies.fromVertices(x, y, parts, options, true, 0.01, 0, 0.01)
  } catch {
    return Matter.Bodies.circle(x, y, definition.radius ?? 24, options, 24)
  }
}
registerPhysicsBodyFactory('polygon', (definition, x, y, options) => Matter.Bodies.polygon(x, y, Math.max(3, definition.sides ?? 3), definition.radius ?? 22, options))
registerPhysicsBodyFactory('box', (definition, x, y, options) => Matter.Bodies.rectangle(x, y, definition.width ?? 80, definition.height ?? 12, options))
