import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { SceneObject } from '../physics/SimulationScene'
import { SCENE_HEIGHT, SCENE_WIDTH } from '../physics/SimulationScene'
import { ARENA_CENTER, ARENA_NECK, ARENA_RADIUS, ARENA_VERTICAL_OFFSET } from '../arena/geometry'
import { getMergeAnimationProgress, getMergePopScale, MERGE_ANIMATION_MS } from './mergeAnimation'
import { getImageScaleFactor } from './imageSizing'

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

type MergeSpark = {
  graphic: Graphics
  direction: Point
  speed: number
}

type MergeBurst = {
  container: Container
  ring: Graphics
  sparks: MergeSpark[]
  elapsed: number
}

const MAX_MERGE_BURSTS = 24
const MERGE_SPARK_COLORS = [0x8dff32, 0x24d8ff, 0xff38a8, 0xffffff, 0x754bff]

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

export class PixiSceneRenderer {
  readonly app = new Application()
  private readonly root = new Container()
  private readonly frame = new Graphics()
  private readonly arenaGlow = new Graphics()
  private readonly arena = new Graphics()
  private readonly mergeEffects = new Container()
  private readonly selectionOutline = new Graphics()
  private readonly nodes = new Map<string, Graphics | Sprite>()
  private readonly signatures = new Map<string, string>()
  private readonly imageSources = new Map<string, string>()
  private readonly imageTextures = new Map<string, { refs: number; promise: Promise<Texture> }>()
  private readonly mergeBursts: MergeBurst[] = []
  private readonly mergePops = new Map<string, number>()
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
    // Keep the feed lane and canvas edges visually unmarked. The bowl is the
    // only visible location boundary; its Matter.js chute remains in place.
    this.app.stage.addChild(this.frame)
    this.app.stage.addChild(this.arenaGlow)
    this.app.stage.addChild(this.arena)
    this.app.stage.addChild(this.root)
    this.app.stage.addChild(this.mergeEffects)
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
        const nextSource = (item.definition.visual ?? item.definition.kind) === 'image'
          ? item.definition.imageSrc
          : undefined
        if (nextSource) this.imageSources.set(item.definition.id, nextSource)
        else this.imageSources.delete(item.definition.id)
        // createNode acquires the replacement before releasing the old ref.
        // This matters when a node is recreated with the same URL: releasing
        // it still balances the ref count, but the URL mapping must remain.
        if (previousSource) this.releaseImageReference(previousSource)
        this.root.addChild(node)
      }
      node.rotation = item.body.angle
      const popProgress = this.mergePops.get(item.definition.id)
      const popScale = popProgress === undefined ? 1 : getMergePopScale(getMergeAnimationProgress(popProgress))
      // Keep the fitted texture scale for PNG sprites; setting scale to the
      // animation multiplier alone would restore their original pixel size.
      if (this.isSpriteNode(node)) {
        this.setImageSize(node, item.definition.radius ?? 24, popScale)
        node.position.set(item.body.position.x, item.body.position.y)
      } else {
        node.position.set(item.body.position.x, item.body.position.y)
        node.scale.set(popScale)
      }
      node.alpha = (node instanceof Graphics && !this.isSpriteNode(node) && item.body.isSleeping ? 0.92 : 1)
        * (popProgress === undefined ? 1 : Math.min(1, popProgress / 90))
    }
    for (const [id, node] of this.nodes) {
      if (!active.has(id)) {
        this.root.removeChild(node)
        this.destroyNode(node)
        this.mergePops.delete(id)
        this.releaseImageSource(id)
        this.imageSources.delete(id)
        this.nodes.delete(id)
        this.signatures.delete(id)
      }
    }
    this.drawSelection(objects)
  }

  /**
   * Decode and retain a PNG before its Matter body is created. The returned
   * release function should be called after sync() has attached the sprite,
   * which then owns its own reference to the same cached texture.
   */
  async prepareImageSource(source: string): Promise<() => void> {
    try {
      await this.acquireImageTexture(source)
    } catch (error) {
      this.releaseImageReference(source)
      throw error
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseImageReference(source)
    }
  }

  setSelected(id?: string) { this.selectedId = id; }

  /**
   * Play presentation-only feedback for a merge already accepted by the
   * physics coordinator. This does not alter Matter bodies or React state.
   */
  playMergeAnimation(position: Point, resultId: string) {
    if (!this.initialized) return
    this.mergePops.set(resultId, 0)

    // Bound transient allocations if a heavily populated arena merges many
    // pairs at once. Dropping the oldest visual never affects simulation.
    if (this.mergeBursts.length >= MAX_MERGE_BURSTS) this.destroyMergeBurst(this.mergeBursts.shift()!)

    const container = new Container()
    container.position.set(position.x, position.y)
    const ring = new Graphics()
      .circle(0, 0, 22)
      .stroke({ color: 0xffffff, width: 2.5, alpha: 0.95 })
      .circle(0, 0, 15)
      .stroke({ color: 0x24d8ff, width: 1.5, alpha: 0.78 })
    container.addChild(ring)

    const sparks: MergeSpark[] = []
    const sparkCount = 10
    for (let index = 0; index < sparkCount; index += 1) {
      const angle = (Math.PI * 2 * index) / sparkCount
      const direction = { x: Math.cos(angle), y: Math.sin(angle) }
      const graphic = new Graphics()
        .circle(0, 0, index % 3 === 0 ? 2.8 : 2)
        .fill(MERGE_SPARK_COLORS[index % MERGE_SPARK_COLORS.length]!)
      container.addChild(graphic)
      sparks.push({ graphic, direction, speed: 36 + (index % 4) * 9 })
    }

    this.mergeEffects.addChild(container)
    this.mergeBursts.push({ container, ring, sparks, elapsed: 0 })
  }

  /** Advance visual effects from the existing Pixi ticker (even when paused). */
  updateAnimations(deltaMs: number) {
    const safeDelta = Math.max(0, Math.min(deltaMs, 100))
    for (const [id, elapsed] of this.mergePops) {
      const next = elapsed + safeDelta
      if (next >= MERGE_ANIMATION_MS) {
        this.mergePops.delete(id)
      } else {
        this.mergePops.set(id, next)
      }
    }

    for (let index = this.mergeBursts.length - 1; index >= 0; index -= 1) {
      const burst = this.mergeBursts[index]!
      burst.elapsed += safeDelta
      const progress = getMergeAnimationProgress(burst.elapsed)
      const eased = 1 - (1 - progress) ** 3
      burst.ring.scale.set(0.25 + eased * 1.55)
      burst.ring.alpha = 1 - progress
      for (const spark of burst.sparks) {
        const distance = spark.speed * progress
        spark.graphic.position.set(spark.direction.x * distance, spark.direction.y * distance)
        spark.graphic.scale.set(1 - progress * 0.7)
        spark.graphic.alpha = 1 - progress
      }
      if (progress >= 1) {
        this.mergeBursts.splice(index, 1)
        this.destroyMergeBurst(burst)
      }
    }
  }

  resize(width: number, height: number) {
    if (!this.initialized) return
    const scale = Math.min(width / SCENE_WIDTH, height / SCENE_HEIGHT)
    this.app.canvas.style.width = `${SCENE_WIDTH * scale}px`
    this.app.canvas.style.height = `${SCENE_HEIGHT * scale}px`
  }

  destroy() {
    for (const burst of this.mergeBursts) this.destroyMergeBurst(burst)
    this.mergeBursts.length = 0
    this.mergePops.clear()
    for (const [id, node] of this.nodes) {
      this.destroyNode(node)
      this.releaseImageSource(id)
    }
    this.nodes.clear()
    this.signatures.clear()
    this.imageSources.clear()
    this.app.destroy(true, { children: true, texture: false, textureSource: false, context: true })
    this.initialized = false
  }

  private destroyMergeBurst(burst: MergeBurst) {
    if (burst.container.parent) burst.container.parent.removeChild(burst.container)
    burst.container.destroy({ children: true })
  }

  private drawArena() {
    this.arenaGlow.clear()
    this.arena.clear()
    if (!this.arenaGeometry.enabled) return

    const geometry = this.arenaGeometry
    // Continue the arena rails beyond the top of the preview. This makes the
    // entrance part of the visible arena outline without showing a spawn area.
    const leftTop = { x: geometry.chuteLeftX, y: geometry.chuteTopY }
    const rightTop = { x: geometry.chuteRightX, y: geometry.chuteTopY }
    const leftBottom = { x: geometry.chuteLeftX, y: geometry.chuteBottomY }
    const rightBottom = { x: geometry.chuteRightX, y: geometry.chuteBottomY }
    const leftShoulder = {
      x: geometry.ringCenterX + Math.cos(geometry.ringStartAngle) * geometry.ringRadius,
      y: geometry.ringCenterY + Math.sin(geometry.ringStartAngle) * geometry.ringRadius,
    }
    const rightShoulder = {
      x: geometry.ringCenterX + Math.cos(geometry.ringEndAngle) * geometry.ringRadius,
      y: geometry.ringCenterY + Math.sin(geometry.ringEndAngle) * geometry.ringRadius,
    }
    // Keep Pixi's bowl geometry aligned with the shared Matter.js path.
    const controlOffset = geometry.chuteBottomY - defaultArenaGeometry.chuteBottomY
    const path: Point[] = [leftTop, leftBottom]
    path.push(...cubic(leftBottom,
      { x: 110, y: 111 + ARENA_VERTICAL_OFFSET + controlOffset },
      { x: 58, y: 145 + ARENA_VERTICAL_OFFSET + controlOffset },
      leftShoulder, 24))
    for (let index = 1; index <= 72; index += 1) {
      const angle = geometry.ringStartAngle + (geometry.ringEndAngle - geometry.ringStartAngle) * (index / 72)
      path.push({
        x: geometry.ringCenterX + Math.cos(angle) * geometry.ringRadius,
        y: geometry.ringCenterY + Math.sin(angle) * geometry.ringRadius,
      })
    }
    path.push(...cubic(rightShoulder,
      { x: 302, y: 145 + ARENA_VERTICAL_OFFSET + controlOffset },
      { x: 250, y: 111 + ARENA_VERTICAL_OFFSET + controlOffset },
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
    const drawContinuous = (graphics: Graphics, width: number, alpha: number, color: number) => {
      graphics.moveTo(path[0]!.x, path[0]!.y)
      for (let index = 1; index < path.length; index += 1) graphics.lineTo(path[index]!.x, path[index]!.y)
      graphics.stroke({ color, width, alpha })
    }
    // Draw one continuous dark under-stroke first. It hides tiny joins between
    // gradient segments and gives the arena a clean, designed edge at any
    // zoom level.
    this.arena.moveTo(path[0]!.x, path[0]!.y)
    for (let index = 1; index < path.length; index += 1) this.arena.lineTo(path[index]!.x, path[index]!.y)
    this.arena.stroke({ color: 0x11131f, width: geometry.strokeWidth + 3.5, alpha: 0.95 })
    // A broad low-alpha pass gives the line a soft glow without a per-frame
    // filter allocation.  The crisp pass remains selectable as a static layer.
    drawContinuous(this.arenaGlow, geometry.strokeWidth * 7, 0.10, 0xffb52f)
    drawContinuous(this.arenaGlow, geometry.strokeWidth * 3, 0.16, 0xffe16a)
    drawSegments(this.arena, geometry.strokeWidth, 0.98)
  }

  private createNode(item: SceneObject) {
    const { definition } = item
    const visual = definition.visual ?? definition.kind
    if (visual === 'image' && definition.imageSrc) {
      // A collection PNG is represented by a blob URL. Decode it through the
      // browser's image loader first, then give Pixi the ready image element;
      // this avoids Pixi's URL resolver/loader guessing from an extension that
      // blob URLs do not have (and works consistently across browsers).
      const source = definition.imageSrc
      const sprite = new Sprite(Texture.EMPTY)
      sprite.anchor.set(0.5)
      sprite.visible = false
      void this.acquireImageTexture(source).then((texture) => {
        // The object may have been removed/replaced while the browser was
        // decoding. Do not resurrect stale sprites or leak their GPU texture.
        if (this.nodes.get(definition.id) !== sprite || this.imageSources.get(definition.id) !== source) {
          return
        }
        sprite.texture = texture
        const popProgress = this.mergePops.get(definition.id)
        const popScale = popProgress === undefined ? 1 : getMergePopScale(getMergeAnimationProgress(popProgress))
        this.setImageSize(sprite, definition.radius ?? 24, popScale)
        sprite.visible = true
      }).catch((error: unknown) => {
        if (this.nodes.get(definition.id) === sprite && this.imageSources.get(definition.id) === source) {
          console.error(`Не удалось загрузить PNG-объект «${definition.label}»:`, error)
          // The stage is image-only: keep failed image uploads invisible
          // rather than replacing them with a colored circle placeholder.
        }
      })
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

  /** Apply the physical diameter to a PNG without distorting its proportions. */
  private setImageSize(sprite: Sprite, radius: number, animationScale = 1) {
    const textureWidth = Math.max(1, sprite.texture.width)
    const textureHeight = Math.max(1, sprite.texture.height)
    const scale = getImageScaleFactor(radius, textureWidth, textureHeight, animationScale)
    // Use Pixi's uniform scale directly. Setting width and height separately
    // routes through Pixi's bounds setters and can produce a stale/anisotropic
    // result when a texture is swapped in after the Sprite was created.
    sprite.scale.set(scale)
  }

  /**
   * Avoid relying on `instanceof Sprite`: Pixi can expose more than one
   * module copy during Vite HMR, while the object is still a real Sprite.
   * The texture/anchor pair is specific to image nodes created above.
   */
  private isSpriteNode(node: Graphics | Sprite): node is Sprite {
    return 'texture' in node && 'anchor' in node
  }

  private revokeBlobUrl(source?: string) {
    if (source?.startsWith('blob:')) URL.revokeObjectURL(source)
  }

  private acquireImageTexture(source: string) {
    let entry = this.imageTextures.get(source)
    if (!entry) {
      const image = new Image()
      image.decoding = 'async'
      image.src = source
      const promise = image.decode().then(() => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          throw new Error('PNG не содержит декодируемого изображения.')
        }
        return Texture.from(image)
      }).catch((error: unknown) => {
        image.src = ''
        throw error
      })
      entry = { refs: 0, promise }
      this.imageTextures.set(source, entry)
      const created = entry
      void entry.promise.catch(() => {
        if (this.imageTextures.get(source) === created && created.refs === 0) {
          this.imageTextures.delete(source)
          this.revokeBlobUrl(source)
        }
      })
    }
    entry.refs += 1
    return entry.promise
  }

  private releaseImageSource(id: string, knownSource = this.imageSources.get(id)) {
    if (!knownSource) return
    if (this.imageSources.get(id) === knownSource) this.imageSources.delete(id)
    this.releaseImageReference(knownSource)
  }

  private releaseImageReference(knownSource: string) {
    const entry = this.imageTextures.get(knownSource)
    if (!entry) {
      this.revokeBlobUrl(knownSource)
      return
    }
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0) return
    const released = entry
    void entry.promise.then(async () => {
      if (released.refs > 0 || this.imageTextures.get(knownSource) !== released) return
      this.imageTextures.delete(knownSource)
      // Each blob URL gets its own decoded HTMLImageElement and texture, so
      // destroying the source here cannot invalidate another scene object.
      try {
        const texture = await released.promise
        texture.destroy(true)
      } catch (error) { console.warn('Не удалось освободить PNG-текстуру:', error) }
      this.revokeBlobUrl(knownSource)
    }).catch(() => {
      if (this.imageTextures.get(knownSource) === released && released.refs === 0) this.imageTextures.delete(knownSource)
      this.revokeBlobUrl(knownSource)
    })
  }

  private destroyNode(node: Graphics | Sprite) {
    // The renderer's URL ref-count releases Pixi-managed textures after the
    // sprite is detached. Destroying the shared Assets texture here would
    // leave stale cache entries for sprites that are still alive.
    if (node instanceof Sprite) node.destroy({ texture: false, textureSource: false })
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
