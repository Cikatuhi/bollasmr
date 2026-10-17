import { useEffect, useRef } from 'react'
import { AudioEngine } from '../audio/AudioEngine'
import type { ObjectDefinition, ObjectKind } from '../objects/definitions'
import type { PhysicsSettings, SceneObject } from '../physics/SimulationScene'
import { SimulationScene, SCENE_HEIGHT, SCENE_WIDTH } from '../physics/SimulationScene'
import { PixiSceneRenderer } from '../rendering/PixiSceneRenderer'
import Matter from 'matter-js'
import { MergeSystem } from '../physics/MergeSystem'
import type { UserCollection } from '../collections/persistence'

export type SceneController = {
  setRunning: (running: boolean) => void
  reset: (count: number) => void
  setSettings: (settings: Partial<PhysicsSettings>) => void
  addObject: (kind: ObjectKind, overrides?: Partial<ObjectDefinition>) => SceneObject | undefined
  addDefinition: (definition: ObjectDefinition) => SceneObject | undefined
  updateObject: (id: string, changes: Partial<ObjectDefinition>) => SceneObject | undefined
  setSelected: (id?: string) => void
  removeAll: () => void
  getObjects: () => SceneObject[]
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
    let merge: MergeSystem
    const scene = new SimulationScene((a, b, impact) => {
      if (a.definition.id === 'wall' || b.definition.id === 'wall') {
        void sound.play('wall', impact)
        return
      }
      if (merge.isCandidate(a, b)) merge.enqueue(a, b, impact)
      else void sound.play(a.definition.kind, impact)
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
            radius: level.size / 2, mass: level.mass, imageSrc,
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
      onMerged: ({ from, impact }) => {
        void sound.playMergeSound(from.collectionId, from.level, impact)
        changedRef.current?.()
      },
      onError: (error) => console.error('Ошибка слияния объектов:', error),
    })
    const renderer = new PixiSceneRenderer()
    scene.setPostStepListener(() => { if (merge.flush() > 0) renderer.sync(scene.objects) })
    let disposed = false
    let attached = false
    let initialized = false
    let running = true
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
      scene.createDemo(24)
      pointerCanvas = renderer.app.canvas
      pointerCanvas.addEventListener('pointerdown', onPointerDown)
      pointerCanvas.addEventListener('pointermove', onPointerMove)
      pointerCanvas.addEventListener('pointerup', onPointerUp)
      pointerCanvas.addEventListener('pointercancel', onPointerUp)
      tick = () => {
        if (running) scene.step(renderer.app.ticker.deltaMS)
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
        reset: (count) => { scene.createDemo(count); renderer.setSelected(undefined); renderer.sync(scene.objects) },
        setSettings: (settings) => scene.updateSettings(settings),
        addObject: (kind, overrides) => {
          const object = scene.create(kind, 160 + Math.random() * 40, 55, overrides)
          renderer.setSelected(object?.definition.id)
          return object
        },
        addDefinition: (definition) => {
          const object = scene.addObject(definition, 160 + Math.random() * 40, 55)
          renderer.setSelected(object?.definition.id)
          renderer.sync(scene.objects)
          return object
        },
        updateObject: (id, changes) => scene.updateObject(id, changes),
        setSelected: (id) => renderer.setSelected(id),
        removeAll: () => { scene.clearObjects(); renderer.setSelected(undefined); renderer.sync(scene.objects) },
        getObjects: () => scene.objects,
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
