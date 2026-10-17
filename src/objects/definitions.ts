/** Add custom kind keys with module augmentation when extending the object registry. */
export interface ObjectKindMap {
  circle: unknown
  polygon: unknown
  image: unknown
  box: unknown
}
export type ObjectKind = keyof ObjectKindMap
export type ObjectVisual = 'circle' | 'polygon' | 'image' | 'box'

export type MotionDefinition = {
  type: 'oscillate-x'
  amplitude: number
  period: number
  phase?: number
}

export type ObjectDefinition = {
  id: string
  kind: ObjectKind
  visual?: ObjectVisual
  label: string
  color: number
  radius?: number
  sides?: number
  width?: number
  height?: number
  imageSrc?: string
  isStatic?: boolean
  density?: number
  mass?: number
  restitution?: number
  motion?: MotionDefinition
  /** Optional merge metadata for user-authored level objects. */
  collectionId?: string
  level?: number
}

export type ObjectTemplate = Omit<ObjectDefinition, 'id'>

export const objectTemplates: Partial<Record<ObjectKind, ObjectTemplate>> = {
  circle: { kind: 'circle', visual: 'circle', label: 'Шар', color: 0x8e7cff, radius: 16, density: 0.002, restitution: 0.82 },
  polygon: { kind: 'polygon', visual: 'polygon', label: 'Треугольник', color: 0xffa263, radius: 22, sides: 3, density: 0.002, restitution: 0.58 },
  image: { kind: 'image', visual: 'image', label: 'Изображение', color: 0xffffff, radius: 24, density: 0.002, restitution: 0.45 },
  box: { kind: 'box', visual: 'box', label: 'Платформа', color: 0x34435b, width: 100, height: 12, density: 0.002, restitution: 0.5 },
}

export const ballPalette = [0x8e7cff, 0xff7693, 0x5ee1c0, 0xffb86b, 0x65b8ff, 0xe4e75d, 0xff8fdb, 0x78db75]

export function registerObjectTemplate(kind: ObjectKind, template: ObjectTemplate) {
  objectTemplates[kind] = { ...template, kind }
}

export function makeDefinition(kind: ObjectKind, id: string, overrides: Partial<ObjectDefinition> = {}): ObjectDefinition {
  const template = objectTemplates[kind]
  if (!template) throw new Error(`Не зарегистрирован шаблон объекта «${kind}».`)
  return { ...template, ...overrides, id, kind }
}
