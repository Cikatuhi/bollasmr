import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { SceneObject } from '../physics/SimulationScene'
import { SCENE_HEIGHT, SCENE_WIDTH } from '../physics/SimulationScene'
import { ARENA_CENTER, ARENA_NECK, ARENA_RADIUS } from '../arena/geometry'

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

/**
 * Visual geometry for the neon "drop" arena.  The physics world owns its
 * collision path separately; this is a presentation layer that deliberately
 * does not mutate object or selection containers. Keeping the values here
 * (rather than hard-coding the path in mount()) makes editable arenas possible
 * later without coupling them to the Pixi object renderer.
 */
export type ArenaGeometry = {
  enabled?: boolean
  chuteLeftX?: number
  chuteRightX?: number
  chuteTopY?: number
  chuteBottomY?: number
  ringCenterX?: number
  ringCenterY?: number
  ringRadius?: number
  ringStartAngle?: number
  ringEndAngle?: number
  strokeWidth?: number
}

const defaultArenaGeometry: Required<ArenaGeometry> = {
  enabled: true,
  chuteLeftX: ARENA_NECK.left,
  chuteRightX: ARENA_NECK.right,
  chuteTopY: ARENA_NECK.top,
  chuteBottomY: ARENA_NECK.shoulderY,
  ringCenterX: ARENA_CENTER.x,
  ringCenterY: ARENA_CENTER.y,
  ringRadius: ARENA_RADIUS,
  // Angles are in radians.  The decreasing range traces the lower arc
  // (left shoulder -> bottom -> right shoulder) in screen coordinates.
  ringStartAngle: -146 * Math.PI / 180,
  ringEndAngle: -390 * Math.PI / 180,
  strokeWidth: 2.3,
}

type Point = { x: number; y: number }

const arenaGradient = [
  { at: 0, color: 0x24d8ff },
  { at: 0.16, color: 0x8dff32 },
  { at: 0.28, color: 0xffa22b },
  { at: 0.4, color: 0xff38a8 },
  { at: 0.58, color: 0x754bff },
  { at: 0.72, color: 0x12ceff },
  { at: 0.86, color: 0x57f443 },
  { at: 1, color: 0xffc929 },
] as const

function interpolateColor(from: number, to: number, amount: number) {
  const r = Math.round(((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * amount)
  const g = Math.round(((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * amount)
  const b = Math.round((from & 0xff) + ((to & 0xff) - (from & 0xff)) * amount)
  return (r << 16) | (g << 8) | b
}

function gradientColor(at: number) {
  const value = Math.max(0, Math.min(1, at))
  for (let index = 1; index < arenaGradient.length; index += 1) {
    const stop = arenaGradient[index]!
    if (value <= stop.at) {
      const previous = arenaGradient[index - 1]!
      const amount = (value - previous.at) / Math.max(0.0001, stop.at - previous.at)
      return interpolateColor(previous.color, stop.color, amount)
    }
  }
  return arenaGradient[arenaGradient.length - 1]!.color
}

function cubic(from: Point, control1: Point, control2: Point, to: Point, steps: number) {
  const points: Point[] = []
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps
    const inverse = 1 - t
    points.push({
      x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * to.x,
      y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * to.y,
    })
  }
  return points
}

export class PixiSceneRenderer {
  readonly app = new Application()
  private readonly root = new Container()
  private readonly frame = new Graphics()
  private readonly arenaGlow = new Graphics()
  private readonly arena = new Graphics()
  private readonly selectionOutline = new Graphics()
  private readonly nodes = new Map<string, Graphics | Sprite>()
  private readonly signatures = new Map<string, string>()
  private readonly imageSources = new Map<string, string>()
  private initialized = false
  private selectedId?: string
  private arenaGeometry: Required<ArenaGeometry>

  constructor(options: { arena?: ArenaGeometry } = {}) {
    this.arenaGeometry = { ...defaultArenaGeometry, ...options.arena }
  }

  async mount(host: HTMLElement) {
    if (this.initialized) return
    await this.app.init({
      // A near-black canvas keeps the neon path readable and mirrors the
      // vertical short-form video look of the reference arena.
      background: '#020304',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
    })
    host.appendChild(this.app.canvas)
    this.frame
      .rect(0, 0, SCENE_WIDTH, SCENE_HEIGHT)
      .fill({ color: '#020304' })
    // Keep a very subtle inner edge, but avoid the former card-like frame:
    // the arena itself is the visual boundary now.
    this.frame.rect(8, 8, SCENE_WIDTH - 16, SCENE_HEIGHT - 16)
      .stroke({ color: '#111721', width: 1, alpha: 0.65 })
    this.app.stage.addChild(this.frame)
    this.app.stage.addChild(this.arenaGlow)
    this.app.stage.addChild(this.arena)
    this.app.stage.addChild(this.root)
    this.app.stage.addChild(this.selectionOutline)
    this.drawArena()
    this.initialized = true
  }

  /** Update the visual arena without touching object or selection layers. */
  setArenaGeometry(patch: ArenaGeometry) {
    this.arenaGeometry = { ...this.arenaGeometry, ...patch }
    if (this.initialized) this.drawArena()
  }

  sync(objects: SceneObject[]) {
    if (!this.initialized) return
    const active = new Set<string>()
    for (const item of objects) {
      active.add(item.definition.id)
      let node = this.nodes.get(item.definition.id)
      const signature = this.signature(item)
      if (!node || this.signatures.get(item.definition.id) !== signature) {
        const previousSource = this.imageSources.get(item.definition.id)
        if (node) { this.root.removeChild(node); this.destroyNode(node) }
        node = this.createNode(item)
        this.nodes.set(item.definition.id, node)
        this.signatures.set(item.definition.id, signature)
        if (item.definition.imageSrc) this.imageSources.set(item.definition.id, item.definition.imageSrc)
        else this.imageSources.delete(item.definition.id)
        if (previousSource && previousSource !== item.definition.imageSrc) this.revokeBlobUrl(previousSource)
        this.root.addChild(node)
      }
      node.position.set(item.body.position.x, item.body.position.y)
      node.rotation = item.body.angle
      if (node instanceof Sprite) {
        const size = (item.definition.radius ?? 24) * 2
        const textureWidth = Math.max(1, node.texture.width)
        const textureHeight = Math.max(1, node.texture.height)
        const scale = size / Math.max(textureWidth, textureHeight)
        node.width = textureWidth * scale
        node.height = textureHeight * scale
      }
      if (node instanceof Graphics) node.alpha = item.body.isSleeping ? 0.92 : 1
    }
    for (const [id, node] of this.nodes) {
      if (!active.has(id)) {
        this.root.removeChild(node)
        this.destroyNode(node)
        this.revokeBlobUrl(this.imageSources.get(id))
        this.imageSources.delete(id)
        this.nodes.delete(id)
        this.signatures.delete(id)
      }
    }
    this.drawSelection(objects)
  }

  setSelected(id?: string) { this.selectedId = id; }

  resize(width: number, height: number) {
    if (!this.initialized) return
    const scale = Math.min(width / SCENE_WIDTH, height / SCENE_HEIGHT)
    this.app.canvas.style.width = `${SCENE_WIDTH * scale}px`
    this.app.canvas.style.height = `${SCENE_HEIGHT * scale}px`
  }

  destroy() {
    for (const [id, node] of this.nodes) {
      this.destroyNode(node)
      this.revokeBlobUrl(this.imageSources.get(id))
    }
    this.nodes.clear()
    this.signatures.clear()
    this.imageSources.clear()
    this.app.destroy(true, { children: true, texture: false, textureSource: false, context: true })
    this.initialized = false
  }

  private drawArena() {
    this.arenaGlow.clear()
    this.arena.clear()
    if (!this.arenaGeometry.enabled) return

    const geometry = this.arenaGeometry
    const leftTop = { x: geometry.chuteLeftX, y: geometry.chuteTopY }
    const leftBottom = { x: geometry.chuteLeftX, y: geometry.chuteBottomY }
    const rightTop = { x: geometry.chuteRightX, y: geometry.chuteTopY }
    const rightBottom = { x: geometry.chuteRightX, y: geometry.chuteBottomY }
    const leftShoulder = {
      x: geometry.ringCenterX + Math.cos(geometry.ringStartAngle) * geometry.ringRadius,
      y: geometry.ringCenterY + Math.sin(geometry.ringStartAngle) * geometry.ringRadius,
    }
    const rightShoulder = {
      x: geometry.ringCenterX + Math.cos(geometry.ringEndAngle) * geometry.ringRadius,
      y: geometry.ringCenterY + Math.sin(geometry.ringEndAngle) * geometry.ringRadius,
    }
    const path: Point[] = [leftTop, leftBottom]
    path.push(...cubic(leftBottom,
      { x: 110, y: 111 },
      { x: 58, y: 145 },
      leftShoulder, 24))
    for (let index = 1; index <= 72; index += 1) {
      const angle = geometry.ringStartAngle + (geometry.ringEndAngle - geometry.ringStartAngle) * (index / 72)
      path.push({
        x: geometry.ringCenterX + Math.cos(angle) * geometry.ringRadius,
        y: geometry.ringCenterY + Math.sin(angle) * geometry.ringRadius,
      })
    }
    path.push(...cubic(rightShoulder,
      { x: 302, y: 145 },
      { x: 250, y: 111 },
      rightBottom, 24))
    path.push(rightTop)

    const drawSegments = (graphics: Graphics, width: number, alpha: number) => {
      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1]!
        const to = path[index]!
        const color = gradientColor((index - 1) / Math.max(1, path.length - 1))
        graphics.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color, width, alpha })
      }
    }
    // A broad low-alpha pass gives the line a soft glow without a per-frame
    // filter allocation.  The crisp pass remains selectable as a static layer.
    drawSegments(this.arenaGlow, geometry.strokeWidth * 7, 0.12)
    drawSegments(this.arenaGlow, geometry.strokeWidth * 3, 0.2)
    drawSegments(this.arena, geometry.strokeWidth, 0.98)
  }

  private createNode(item: SceneObject) {
    const { definition } = item
    const visual = definition.visual ?? definition.kind
    if (visual === 'image' && definition.imageSrc) {
      const sprite = new Sprite(Texture.from(definition.imageSrc))
      const size = (definition.radius ?? 24) * 2
      sprite.anchor.set(0.5)
      const textureWidth = Math.max(1, sprite.texture.width)
      const textureHeight = Math.max(1, sprite.texture.height)
      const scale = size / Math.max(textureWidth, textureHeight)
      sprite.width = textureWidth * scale
      sprite.height = textureHeight * scale
      return sprite
    }
    const graphics = new Graphics()
    const color = hex(definition.color)
    if (visual === 'circle' || visual === 'image') {
      graphics.circle(0, 0, definition.radius ?? 20).fill(color).stroke({ color: '#ffffff', width: 1, alpha: 0.16 })
    } else if (visual === 'polygon') {
      const radius = definition.radius ?? 22
      const sides = definition.sides ?? 3
      const points: number[] = []
      for (let i = 0; i < sides; i += 1) {
        const angle = (i / sides) * Math.PI * 2 - Math.PI / 2
        points.push(Math.cos(angle) * radius, Math.sin(angle) * radius)
      }
      graphics.poly(points).fill(color).stroke({ color: '#ffffff', width: 1, alpha: 0.16 })
    } else {
      graphics.roundRect(-(definition.width ?? 80) / 2, -(definition.height ?? 12) / 2, definition.width ?? 80, definition.height ?? 12, 5).fill(color)
    }
    return graphics
  }

  private signature(item: SceneObject) {
    const { kind, color, radius, sides, width, height, imageSrc } = item.definition
    if ((item.definition.visual ?? item.definition.kind) === 'image' && imageSrc) return `image:${imageSrc}`
    return `${kind}:${item.definition.visual ?? ''}:${color}:${radius}:${sides}:${width}:${height}:${imageSrc ?? ''}`
  }

  private revokeBlobUrl(source?: string) {
    if (source?.startsWith('blob:')) URL.revokeObjectURL(source)
  }

  private destroyNode(node: Graphics | Sprite) {
    if (node instanceof Sprite) node.destroy({ texture: true, textureSource: true })
    else node.destroy()
  }

  private drawSelection(objects: SceneObject[]) {
    this.selectionOutline.clear()
    const selected = objects.find((item) => item.definition.id === this.selectedId)
    if (!selected) return
    const { definition } = selected
    const visual = definition.visual ?? definition.kind
    this.selectionOutline.position.set(selected.body.position.x, selected.body.position.y)
    this.selectionOutline.rotation = selected.body.angle
    if (visual === 'box') {
      this.selectionOutline.roundRect(-(definition.width ?? 80) / 2 - 4, -(definition.height ?? 12) / 2 - 4,
        (definition.width ?? 80) + 8, (definition.height ?? 12) + 8, 7).stroke({ color: '#c9c0ff', width: 1.5, alpha: 0.8 })
    } else if (visual === 'polygon') {
      const radius = (definition.radius ?? 22) + 5
      const points: number[] = []
      for (let i = 0; i < (definition.sides ?? 3); i += 1) {
        const angle = (i / (definition.sides ?? 3)) * Math.PI * 2 - Math.PI / 2
        points.push(Math.cos(angle) * radius, Math.sin(angle) * radius)
      }
      this.selectionOutline.poly(points).stroke({ color: '#c9c0ff', width: 1.5, alpha: 0.8 })
    } else {
      this.selectionOutline.circle(0, 0, (definition.radius ?? 24) + 5).stroke({ color: '#c9c0ff', width: 1.5, alpha: 0.8 })
    }
  }
}
