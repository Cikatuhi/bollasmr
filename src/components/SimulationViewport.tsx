import { useEffect, useRef } from 'react'
import { AudioEngine } from '../audio/AudioEngine'
import type { ObjectDefinition, ObjectKind } from '../objects/definitions'
import type { PhysicsSettings, SceneObject } from '../physics/SimulationScene'
import { MAX_OBJECTS, SimulationScene, SCENE_HEIGHT, SCENE_WIDTH } from '../physics/SimulationScene'
import { PixiSceneRenderer } from '../rendering/PixiSceneRenderer'
import Matter from 'matter-js'
import { MergeSystem } from '../physics/MergeSystem'
import type { UserCollection } from '../collections/persistence'

export type SceneController = {
  setRunning: (running: boolean) => void
  reset: (definitions?: ObjectDefinition[]) => Promise<void>
  setSettings: (settings: Partial<PhysicsSettings>) => void
  addObject: (kind: ObjectKind, overrides?: Partial<ObjectDefinition>) => SceneObject | undefined
  addDefinition: (definition: ObjectDefinition) => Promise<SceneObject | undefined>
  updateObject: (id: string, changes: Partial<ObjectDefinition>) => SceneObject | undefined
  setSelected: (id?: string) => void
  removeAll: () => void
  removeCollectionLevel: (collectionId: string, level: number) => void
  removeCollection: (collectionId: string) => void
  getObjects: () => SceneObject[]
  getCanvas: () => HTMLCanvasElement | undefined
  setMergeEffectsEnabled: (enabled: boolean) => void
}

type Props = {
  sound: AudioEngine
  collections: UserCollection[]
  onController: (controller: SceneController | null) => void
  onSelectObject: (object: ObjectDefinition | null) => void
  onSceneChanged?: () => void
}

export default function SimulationViewport({ sound, collections, onController, onSelectObject, onSceneChanged }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const collectionsRef = useRef(collections)
  const changedRef = useRef(onSceneChanged)
  collectionsRef.current = collections
  changedRef.current = onSceneChanged

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new PixiSceneRenderer()
    let merge: MergeSystem
    const scene = new SimulationScene((a, b, impact) => {
      // Collision audio is intentionally disabled. A collision becomes
      // audible only after MergeSystem has confirmed a successful merge and
      // the replacement body has been created (see onMerged below).
      if (merge.isCandidate(a, b)) merge.enqueue(a, b, impact)
    })
    merge = new MergeSystem({
      getNextLevel: (identity) => {
        const collection = collectionsRef.current.find((item) => item.id === identity.collectionId)
        const level = collection?.levels.find((item) => item.level === identity.level + 1)
        if (!collection || !level || !level.image) return undefined
        const imageSrc = URL.createObjectURL(level.image)
        return {
          identity: { collectionId: collection.id, level: level.level },
          definition: {
            id: `merge-${collection.id}-${level.level}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
            kind: 'image', visual: 'image', label: level.name, color: 0xffffff,
            radius: level.size / 2, mass: level.mass, imageSrc, imageGeometry: level.imageGeometry,
            collectionId: collection.id, level: level.level,
            restitution: scene.settings.restitution,
          },
        }
      },
      removeObject: (object) => scene.removeObject(object),
      createObject: (definition, position, velocity) => {
        const object = scene.addObject(definition, position.x, position.y)
        if (!object) {
          if (definition.imageSrc?.startsWith('blob:')) URL.revokeObjectURL(definition.imageSrc)
          return undefined
        }
        Matter.Body.setVelocity(object.body, velocity)
        return object
      },
      onMerged: ({ from, impact, result, position }) => {
        void sound.playMergeSound(from.collectionId, from.level, impact)
        renderer.playMergeAnimation(position, result.definition.id)
        changedRef.current?.()
      },
      onError: (error) => console.error('Ошибка слияния объектов:', error),
    })
    scene.setPostStepListener(() => { if (merge.flush() > 0) renderer.sync(scene.objects) })
    let disposed = false
    let attached = false
    let initialized = false
    let running = true
    let sceneRevision = 0
    let tick: (() => void) | undefined
    let observer: ResizeObserver | undefined
    let activeDrag: { object: SceneObject; lastX: number; lastY: number; previousX: number; previousY: number } | undefined
    let pointerCanvas: HTMLCanvasElement | undefined
    const getPoint = (event: PointerEvent) => {
      const rect = renderer.app.canvas.getBoundingClientRect()
      return { x: ((event.clientX - rect.left) / rect.width) * SCENE_WIDTH, y: ((event.clientY - rect.top) / rect.height) * SCENE_HEIGHT }
    }
    const onPointerDown = (event: PointerEvent) => {
      const point = getPoint(event)
      const hit = [...scene.objects].reverse().find((item) => Matter.Query.point([item.body], point).length > 0)
      if (!hit) { onSelectObject(null); renderer.setSelected(undefined); return }
      onSelectObject(hit.definition)
      renderer.setSelected(hit.definition.id)
      if (!hit.definition.motion) {
        activeDrag = { object: hit, lastX: point.x, lastY: point.y, previousX: point.x, previousY: point.y }
        renderer.app.canvas.setPointerCapture(event.pointerId)
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!activeDrag) return
      const point = getPoint(event)
      activeDrag.previousX = activeDrag.lastX
      activeDrag.previousY = activeDrag.lastY
      activeDrag.lastX = point.x
      activeDrag.lastY = point.y
      scene.moveObject(activeDrag.object.definition.id, point.x, point.y)
      renderer.sync(scene.objects)
    }
    const onPointerUp = () => {
      if (activeDrag && !activeDrag.object.body.isStatic) {
        scene.moveObject(activeDrag.object.definition.id, activeDrag.lastX, activeDrag.lastY,
          { x: (activeDrag.lastX - activeDrag.previousX) * 0.16, y: (activeDrag.lastY - activeDrag.previousY) * 0.16 })
      }
      activeDrag = undefined
    }

    void renderer.mount(host).then(() => {
      initialized = true
      if (disposed) { renderer.destroy(); return }
      scene.initializeArena()
      const canvas = renderer.app.canvas
      pointerCanvas = canvas
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerUp)
      tick = () => {
        if (running) scene.step(renderer.app.ticker.deltaMS)
        renderer.updateAnimations(renderer.app.ticker.deltaMS)
        renderer.sync(scene.objects)
      }
      renderer.app.ticker.add(tick)
      attached = true
      observer = new ResizeObserver(() => renderer.resize(host.clientWidth, host.clientHeight))
      observer.observe(host)
      renderer.resize(host.clientWidth, host.clientHeight)
      renderer.sync(scene.objects)

      onController({
        setRunning: (next) => { running = next },
        setMergeEffectsEnabled: (enabled) => renderer.setMergeEffectsEnabled(enabled),
        reset: async (definitions = []) => {
          const revision = ++sceneRevision
          scene.clearObjects()
          merge.clear()
          renderer.setSelected(undefined)
          renderer.sync(scene.objects)

          const prepared = await Promise.all(definitions.slice(0, MAX_OBJECTS).map(async (definition) => {
            const source = (definition.visual ?? definition.kind) === 'image' ? definition.imageSrc : undefined
            if (!source) return { definition, release: () => {} }
            try {
              return { definition, release: await renderer.prepareImageSource(source) }
            } catch (error) {
              console.error(`Не удалось подготовить PNG-объект «${definition.label}»:`, error)
              return undefined
            }
          }))

          if (disposed || revision !== sceneRevision) {
            prepared.forEach((item) => item?.release())
            return
          }
          prepared.forEach((item) => {
            if (item && !scene.spawnFromEntrance(item.definition) && item.definition.imageSrc?.startsWith('blob:')) {
              URL.revokeObjectURL(item.definition.imageSrc)
            }
          })
          renderer.sync(scene.objects)
          prepared.forEach((item) => item?.release())
          changedRef.current?.()
        },
        setSettings: (settings) => scene.updateSettings(settings),
        addObject: (kind, overrides) => {
          const object = scene.createFromEntrance(kind, overrides)
          renderer.setSelected(object?.definition.id)
          renderer.sync(scene.objects)
          return object
        },
        addDefinition: async (definition) => {
          const source = (definition.visual ?? definition.kind) === 'image' ? definition.imageSrc : undefined
          let release = () => {}
          if (source) {
            try {
              release = await renderer.prepareImageSource(source)
            } catch (error) {
              console.error(`Не удалось подготовить PNG-объект «${definition.label}»:`, error)
              return undefined
            }
          }
          if (disposed) { release(); return undefined }
          const object = scene.spawnFromEntrance(definition)
          renderer.setSelected(object?.definition.id)
          renderer.sync(scene.objects)
          release()
          changedRef.current?.()
          return object
        },
        updateObject: (id, changes) => scene.updateObject(id, changes),
        setSelected: (id) => renderer.setSelected(id),
        removeAll: () => { merge.clear(); scene.clearObjects(); renderer.setSelected(undefined); renderer.sync(scene.objects) },
        removeCollectionLevel: (collectionId, level) => {
          for (const object of [...scene.objects]) {
            if (object.definition.collectionId === collectionId && object.definition.level === level) scene.removeObject(object)
          }
          renderer.sync(scene.objects)
        },
        removeCollection: (collectionId) => {
          for (const object of [...scene.objects]) {
            if (object.definition.collectionId === collectionId) scene.removeObject(object)
          }
          renderer.sync(scene.objects)
        },
        getObjects: () => scene.objects,
        getCanvas: () => renderer.app.canvas,
      })
    }).catch((error: unknown) => console.error('Не удалось запустить PixiJS:', error))

    return () => {
      disposed = true
      observer?.disconnect()
      pointerCanvas?.removeEventListener('pointerdown', onPointerDown)
      pointerCanvas?.removeEventListener('pointermove', onPointerMove)
      pointerCanvas?.removeEventListener('pointerup', onPointerUp)
      pointerCanvas?.removeEventListener('pointercancel', onPointerUp)
      if (attached && tick) renderer.app.ticker.remove(tick)
      scene.destroy()
      if (initialized) renderer.destroy()
      onController(null)
    }
  }, [onController, onSelectObject, sound])

  return <div ref={hostRef} className="simulation-host" aria-label="Поле физической симуляции" />
}
