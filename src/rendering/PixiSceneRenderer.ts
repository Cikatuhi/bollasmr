import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { SceneObject } from '../physics/SimulationScene'
import { SCENE_HEIGHT, SCENE_WIDTH } from '../physics/SimulationScene'

const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`

export class PixiSceneRenderer {
  readonly app = new Application()
  private readonly root = new Container()
  private readonly frame = new Graphics()
  private readonly selectionOutline = new Graphics()
  private readonly nodes = new Map<string, Graphics | Sprite>()
  private readonly signatures = new Map<string, string>()
  private readonly imageSources = new Map<string, string>()
  private initialized = false
  private selectedId?: string

  async mount(host: HTMLElement) {
    if (this.initialized) return
    await this.app.init({
      background: '#15171d',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
    })
    host.appendChild(this.app.canvas)
    this.frame
      .roundRect(8, 8, SCENE_WIDTH - 16, SCENE_HEIGHT - 16, 20)
      .fill({ color: '#191c24' })
      .stroke({ color: '#353a48', width: 1.5 })
    for (let y = 48; y < SCENE_HEIGHT - 20; y += 40) {
      this.frame.moveTo(16, y).lineTo(SCENE_WIDTH - 16, y).stroke({ color: '#282d38', width: 1, alpha: 0.45 })
    }
    this.app.stage.addChild(this.frame)
    this.app.stage.addChild(this.root)
    this.app.stage.addChild(this.selectionOutline)
    this.initialized = true
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
