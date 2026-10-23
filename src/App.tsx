import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, MouseEvent, ReactNode } from 'react'
import { AudioEngine } from './audio/AudioEngine'
import SimulationViewport, { type SceneController } from './components/SimulationViewport'
import CollectionEditor from './components/CollectionEditor'
import TermsPage from './TermsPage'
import TariffsPage from './TariffsPage'
import PrivacyPage from './PrivacyPage'
import BallPlayMark from './components/BallPlayMark'
import { createCollectionStore, type CollectionLevel, type CollectionStore, type UserCollection } from './collections/persistence'
import { DEFAULT_RESTITUTION, type ObjectDefinition } from './objects/definitions'
import { createImageCollisionGeometry, MAX_COLLISION_PARTS, type ImageCollisionGeometry } from './objects/imageCollisionGeometry'
import { MAX_OBJECTS } from './physics/SimulationScene'

// PNGs need time to clear the narrow entrance. At 10 objects/sec they stack
// faster than gravity can carry them into the bowl, especially at large sizes.
const RECORDING_SPAWN_INTERVAL_MS = 500

const pretty = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    play: <path d="m7 4 13 8-13 8V4Z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5h3v14H8zM15 5h3v14h-3z" fill="currentColor" stroke="none" /></>,
    reset: <><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" /><path d="M3 3v5h5" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    ball: <circle cx="12" cy="12" r="8" />,
    polygon: <path d="m12 3 9 16H3L12 3Z" />,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    platform: <><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 5v3m10-3v3" /></>,
    sound: <><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M17 9a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12" /></>,
    sparkle: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function RangeControl({ label, value, min, max, step, suffix, onChange }: {
  label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void
}) {
  const percentage = ((value - min) / (max - min)) * 100
  return <label className="range-control">
    <span className="range-label"><span>{label}</span><span className="range-value">{pretty(value)}{suffix}</span></span>
    <input type="range" min={min} max={max} step={step} value={value} style={{ '--range-progress': `${percentage}%` } as CSSProperties} onChange={(event) => onChange(Number(event.target.value))} />
    <span className="range-limits"><span>{min}{suffix}</span><span>{max}{suffix}</span></span>
  </label>
}

function EditorApp() {
  const sound = useMemo(() => new AudioEngine(), [])
  const [controller, setController] = useState<SceneController | null>(null)
  const [running, setRunning] = useState(true)
  const [gravity, setGravity] = useState(1)
  const [restitution, setRestitution] = useState(DEFAULT_RESTITUTION)
  const [speed, setSpeed] = useState(0.5)
  const [volume, setVolume] = useState(0.32)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [recording, setRecording] = useState(false)
  const [recordingError, setRecordingError] = useState('')
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null)
  const [recordedDuration, setRecordedDuration] = useState(0)
  const [recordedCurrentTime, setRecordedCurrentTime] = useState(0)
  const recordedVideoRef = useRef<HTMLVideoElement | null>(null)
  const recordingSpawnTimerRef = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingActiveRef = useRef(false)
  const recordingAudioTrackRef = useRef<MediaStreamTrack | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const [selected, setSelected] = useState<ObjectDefinition | null>(null)
  const [objectCount, setObjectCount] = useState(0)
  const [layerItems, setLayerItems] = useState<ObjectDefinition[]>([])
  const [inspectorTab, setInspectorTab] = useState<'settings' | 'layers'>('settings')
  const [collections, setCollections] = useState<UserCollection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>()
  const [collectionsLoaded, setCollectionsLoaded] = useState(false)
  const collectionStoreRef = useRef<CollectionStore | null>(null)
  const hydratedCollectionRef = useRef<string | null>(null)
  const collectionsRef = useRef(collections)
  collectionsRef.current = collections

  const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  useEffect(() => {
    const store = createCollectionStore()
    collectionStoreRef.current = store
    void store.list().then(async (items) => {
      // Upgrade records created before alpha-derived physics shapes existed.
      // Geometry is small JSON data; the PNG itself stays as a Blob in IndexedDB.
      const recovered = await Promise.all(items.map(async (collection) => {
        let changed = false
        const levels = await Promise.all(collection.levels.map(async (level) => {
          if (!level.image || (level.imageGeometry && level.imageGeometry.parts.length <= MAX_COLLISION_PARTS)) return level
          try {
            const imageGeometry = await createImageCollisionGeometry(level.image)
            changed = true
            return { ...level, imageGeometry }
          } catch (error) {
            console.error(`Не удалось обновить физическую оболочку PNG уровня «${level.name}»:`, error)
            return level
          }
        }))
        const next = changed ? { ...collection, levels, updatedAt: Date.now() } : collection
        if (changed) await store.save(next).catch((error) => console.error('Не удалось сохранить восстановленную форму PNG:', error))
        return next
      }))
      setCollections(recovered)
      setSelectedCollectionId(recovered[0]?.id)
      setCollectionsLoaded(true)
      for (const collection of recovered) for (const level of collection.levels) {
        if (level.mergeSound) void sound.loadMergeSound(collection.id, level.level, level.mergeSound, level.mergeSoundVolume, level.mergeSoundRate).catch(() => undefined)
      }
    }).catch((error) => { console.error('Не удалось загрузить коллекции:', error); setCollectionsLoaded(true); window.alert('Не удалось загрузить локальные коллекции.') })
    return () => { store.close?.(); collectionStoreRef.current = null }
  }, [sound])

  const registerController = useCallback((next: SceneController | null) => {
    setController(next)
    if (next) {
      const objects = next.getObjects().map((item) => ({ ...item.definition }))
      setLayerItems(objects)
      setObjectCount(objects.length)
    }
  }, [])
  const registerSelection = useCallback((object: ObjectDefinition | null) => setSelected(object ? { ...object } : null), [])
  const syncSceneState = useCallback(() => {
    if (recordingActiveRef.current) return
    if (!controller) return
    const objects = controller.getObjects().map((item) => ({ ...item.definition }))
    setLayerItems(objects)
    setObjectCount(objects.length)
    setSelected((current) => current && objects.some((item) => item.id === current.id) ? current : null)
  }, [controller])
  // Keep the live Matter scene aligned with the controls after initial mount
  // and Vite Fast Refresh. Otherwise React can show the new calmer defaults
  // while a preserved SimulationScene instance still uses its old settings.
  useEffect(() => {
    controller?.setSettings({ gravity, restitution, speed })
  }, [controller, gravity, restitution, speed])
  useEffect(() => () => {
    sound.dispose()
  }, [sound])
  const applySettings = (next: Partial<{ gravity: number; restitution: number; speed: number }>) => controller?.setSettings(next)

  const updateSelected = (changes: Partial<ObjectDefinition>) => {
    if (!selected) return
    const updated = controller?.updateObject(selected.id, changes)
    setSelected(updated ? { ...updated.definition } : { ...selected, ...changes })
    setLayerItems(controller?.getObjects().map((entry) => ({ ...entry.definition })) ?? [])
  }

  const toggleRunning = () => {
    const next = !running
    setRunning(next)
    controller?.setRunning(next)
  }

  const toggleRecording = async () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
      return
    }
    const canvas = controller?.getCanvas()
    if (!controller || !canvas || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      setRecordingError('Запись видео не поддерживается этим браузером.')
      return
    }
    setRecordingError('')
    const sceneController = controller
    // A recording always starts from a clean scene containing only level-1
    // objects. This prevents objects that were already visible before capture
    // from appearing halfway through the exported video.
    const collection = collectionsRef.current.find((item) => item.id === selectedCollectionId)
    if (collection) {
      try {
        // Decode every level before capture starts. Merge-time texture decode
        // was a visible main-thread/GPU pause in recordings.
        await sceneController.prepareCollectionImages(collection.id)
      } catch (error) {
        console.error('Не удалось подготовить изображения уровней к записи:', error)
        setRecordingError('Не удалось подготовить изображения. Проверь PNG-файлы и попробуй снова.')
        return
      }
    }
    const firstLevelDefinitions = collection
      ? collection.levels.filter((level) => level.image && level.level === 1).map((level) => makeLevelDefinition(collection, level, sceneController.getCollectionImageSource(collection.id, level.level)!))
      : []
    sceneController.setRunning(false)
    await sceneController.reset(firstLevelDefinitions)
    setSelected(null)
    syncSceneState()
    sceneController.setRunning(true)
    setRunning(true)
    let videoStream: MediaStream | undefined
    let stream: MediaStream | undefined
    try {
      const audioTrack = await sound.getRecordingTrack()
      recordingAudioTrackRef.current = audioTrack
      // Ask the browser to capture at 60 FPS. Actual cadence still depends on
      // the render loop and encoder keeping up with the scene complexity.
      videoStream = canvas.captureStream(60)
      stream = new MediaStream([...videoStream.getVideoTracks(), audioTrack])
      // Prefer broadly compatible MP4/H.264 where MediaRecorder supports it;
      // retain WebM as a fallback for browsers without MP4 recording.
      const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = new MediaRecorder(stream, mimeType ? {
        mimeType,
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
      } : { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 })
      recordedChunksRef.current = []
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunksRef.current.push(event.data) }
      recorder.onerror = () => {
        recordingActiveRef.current = false
        if (recordingSpawnTimerRef.current !== null) window.clearInterval(recordingSpawnTimerRef.current)
        recordingSpawnTimerRef.current = null
        setRecording(false)
        setRecordingError('Не удалось записать видео. Попробуй ещё раз.')
        videoStream?.getTracks().forEach((track) => track.stop())
        sound.releaseRecordingTrack(audioTrack)
        recordingAudioTrackRef.current = null
        recorderRef.current = null
      }
      recorder.onstop = () => {
        recordingActiveRef.current = false
        if (recordingSpawnTimerRef.current !== null) window.clearInterval(recordingSpawnTimerRef.current)
        recordingSpawnTimerRef.current = null
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'video/webm' })
        recordedChunksRef.current = []
        videoStream?.getTracks().forEach((track) => track.stop())
        sound.releaseRecordingTrack(audioTrack)
        recordingAudioTrackRef.current = null
        recorderRef.current = null
        setRecording(false)
        if (!blob.size) { setRecordingError('Запись оказалась пустой.'); return }
        const url = URL.createObjectURL(blob)
        setRecordedVideoUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return url })
        setRecordedCurrentTime(0)
        const link = document.createElement('a')
        link.href = url
        const extension = blob.type.includes('mp4') ? 'mp4' : 'webm'
        link.download = `ballplay-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
        link.click()
        window.setTimeout(() => { if (recordedVideoUrl !== url) URL.revokeObjectURL(url) }, 60_000)
      }
      recorderRef.current = recorder
      recordingActiveRef.current = true
      recorder.start(1000)
      setRecording(true)
      const firstLevel = collection?.levels.find((level) => level.image && level.level === 1)
      if (firstLevel && collection) {
        recordingSpawnTimerRef.current = window.setInterval(() => {
          if (sceneController.getObjects().length >= MAX_OBJECTS) return
          const imageSrc = sceneController.getCollectionImageSource(collection.id, firstLevel.level)
          if (!imageSrc) return
          void sceneController.addDefinition(makeLevelDefinition(collection, firstLevel, imageSrc)).then(() => {
            syncSceneState()
          }).catch((error) => console.warn('Не удалось добавить объект в сцену записи:', error))
        }, RECORDING_SPAWN_INTERVAL_MS)
      }
    } catch (error) {
      videoStream?.getTracks().forEach((track) => track.stop())
      if (recordingAudioTrackRef.current) sound.releaseRecordingTrack(recordingAudioTrackRef.current)
      recordingAudioTrackRef.current = null
      console.error('Не удалось начать запись видео:', error)
      setRecordingError('Не удалось начать запись. Проверь разрешения браузера и попробуй снова.')
      setRecording(false)
    }
  }

  useEffect(() => () => {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    if (recordingSpawnTimerRef.current !== null) window.clearInterval(recordingSpawnTimerRef.current)
    if (recordedVideoUrl) URL.revokeObjectURL(recordedVideoUrl)
  }, [recordedVideoUrl])

  const toggleRecordedPlayback = () => {
    const video = recordedVideoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }
  const formatTime = (value: number) => `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`

  const clearScene = () => {
    controller?.removeAll()
    setSelected(null)
    setObjectCount(0)
    setLayerItems([])
  }

  const changeSoundEnabled = (enabled: boolean) => {
    setSoundEnabled(enabled)
    sound.setEnabled(enabled)
    if (enabled) void sound.unlock().catch(() => undefined)
  }
  const changeVolume = (value: number) => { setVolume(value); sound.setVolume(value) }

  const commitCollection = (id: string, update: (collection: UserCollection) => UserCollection) => {
    const current = collections.find((item) => item.id === id)
    if (!current) return
    const next = update({ ...current, levels: current.levels.map((level) => ({ ...level })), updatedAt: Date.now() })
    setCollections((items) => items.map((item) => item.id === id ? next : item))
    void collectionStoreRef.current?.save(next).catch((error) => { console.error(error); window.alert(error instanceof Error ? error.message : 'Не удалось сохранить коллекцию.') })
  }
  const createCollection = () => {
    const now = Date.now()
    const collection: UserCollection = { id: makeId(), name: `Коллекция ${collections.length + 1}`, createdAt: now, updatedAt: now, levels: [{ id: makeId(), level: 1, name: 'Уровень 1', image: null, size: 48, mass: 1, mergeSound: null, mergeSoundVolume: 1, mergeSoundRate: 1 }] }
    setCollections((items) => [...items, collection])
    setSelectedCollectionId(collection.id)
    void collectionStoreRef.current?.save(collection).catch((error) => window.alert(error instanceof Error ? error.message : 'Не удалось сохранить коллекцию.'))
  }
  const deleteCollection = (id: string) => {
    const next = collections.filter((item) => item.id !== id)
    controller?.removeCollection(id)
    setCollections(next)
    setSelectedCollectionId((selected) => selected === id ? next[0]?.id : selected)
    void collectionStoreRef.current?.delete(id).catch((error) => console.error(error))
  }
  const addLevel = (id: string) => commitCollection(id, (collection) => {
    const level = Math.max(0, ...collection.levels.map((item) => item.level)) + 1
    return { ...collection, levels: [...collection.levels, { id: makeId(), level, name: `Уровень ${level}`, image: null, size: 48, mass: 1, mergeSound: null, mergeSoundVolume: 1, mergeSoundRate: 1 }] }
  })
  const deleteLevel = (id: string, levelId: string) => {
    const level = collections.find((item) => item.id === id)?.levels.find((item) => item.id === levelId)
    if (level) controller?.removeCollectionLevel(id, level.level)
    commitCollection(id, (collection) => collection.levels.length <= 1 ? collection : ({ ...collection, levels: collection.levels.filter((item) => item.id !== levelId) }))
    syncSceneState()
  }
  const updateLevel = (id: string, levelId: string, patch: Partial<CollectionLevel>) => {
    const level = collections.find((item) => item.id === id)?.levels.find((item) => item.id === levelId)
    if (level && patch.mergeSoundVolume !== undefined) sound.setMergeSoundVolume(id, level.level, patch.mergeSoundVolume)
    if (level && patch.mergeSoundRate !== undefined) sound.setMergeSoundRate(id, level.level, patch.mergeSoundRate)
    // Keep already spawned PNG instances valid when their collection settings
    // change. Only the physical shell/mass is updated; the existing image
    // resource is preserved, so resizing cannot invalidate loaded textures.
    if (controller && level && (patch.size !== undefined || patch.mass !== undefined)) {
      for (const item of controller.getObjects()) {
        if (item.definition.collectionId !== id || item.definition.level !== level.level) continue
        controller.updateObject(item.definition.id, {
          ...(patch.size !== undefined ? { radius: patch.size / 2 } : {}),
          ...(patch.mass !== undefined ? { mass: patch.mass } : {}),
        })
      }
      syncSceneState()
    }
    commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((item) => item.id === levelId ? { ...item, ...patch } : item) }))
  }
  const uploadCollectionImage = async (id: string, levelId: string, file: File) => {
    if (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png')) { window.alert('Для уровня нужен PNG-файл.'); return }
    if (file.size > 12 * 1024 * 1024) { window.alert('PNG слишком большой (максимум 12 МБ).'); return }
    let imageGeometry: ImageCollisionGeometry
    try {
      imageGeometry = await createImageCollisionGeometry(file)
    } catch (error) {
      console.error('Не удалось подготовить PNG для физической симуляции:', error)
      const message = error instanceof Error && error.message.includes('прозрачный')
        ? error.message
        : 'Не удалось открыть этот PNG или построить по нему физическую оболочку. Проверьте файл и попробуйте сохранить его заново.'
      window.alert(message)
      return
    }
    const collection = collections.find((item) => item.id === id)
    const level = collection?.levels.find((item) => item.id === levelId)
    if (!collection || !level) return
    commitCollection(id, (current) => ({ ...current, levels: current.levels.map((item) => item.id === levelId ? { ...item, image: file, imageName: file.name, imageGeometry } : item) }))
    // Replacing an image replaces its current scene instances too, so an old
    // texture can never remain visible under the new filename.
    controller?.removeCollectionLevel(id, level.level)
    const imageSrc = URL.createObjectURL(file)
    const item = await controller?.addDefinition({ id: `user-${makeId()}`, kind: 'image', visual: 'image', label: level.name, color: 0xffffff, radius: level.size / 2, mass: level.mass, restitution, imageSrc, imageGeometry, useImageOutline: true, collectionId: id, level: level.level })
    if (!item) URL.revokeObjectURL(imageSrc)
    syncSceneState()
  }
  const removeCollectionImage = (id: string, levelId: string) => {
    const level = collections.find((item) => item.id === id)?.levels.find((item) => item.id === levelId)
    if (level) controller?.removeCollectionLevel(id, level.level)
    commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((item) => item.id === levelId ? { ...item, image: null, imageName: undefined, imageGeometry: undefined } : item) }))
    syncSceneState()
  }
  const uploadCollectionSound = (id: string, levelId: string, file: File) => {
    if (!file.type.startsWith('audio/')) { window.alert('Выберите аудиофайл.'); return }
    if (file.size > 20 * 1024 * 1024) { window.alert('Аудиофайл слишком большой (максимум 20 МБ).'); return }
    const collection = collections.find((item) => item.id === id)
    const level = collection?.levels.find((item) => item.id === levelId)
    if (!collection || !level) return
    void sound.loadMergeSound(id, level.level, file, level.mergeSoundVolume, level.mergeSoundRate).then(() => {
      commitCollection(id, (current) => ({ ...current, levels: current.levels.map((item) => item.id === levelId ? { ...item, mergeSound: file, mergeSoundName: file.name } : item) }))
    }).catch(() => window.alert('Не удалось прочитать аудиофайл.'))
  }
  const removeCollectionSound = (id: string, levelId: string) => {
    const level = collections.find((item) => item.id === id)?.levels.find((item) => item.id === levelId)
    if (!level) return
    sound.removeMergeSound(id, level.level)
    commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((item) => item.id === levelId ? { ...item, mergeSound: null, mergeSoundName: undefined } : item) }))
  }
  const makeLevelDefinition = (collection: UserCollection, level: CollectionLevel, imageSrc: string): ObjectDefinition => ({
    id: `user-${makeId()}`, kind: 'image', visual: 'image', label: level.name, color: 0xffffff,
    radius: level.size / 2, mass: level.mass, restitution, imageSrc,
    imageGeometry: level.imageGeometry, useImageOutline: true,
    collectionId: collection.id, level: level.level,
  })
  const definitionsForCollection = (collection?: UserCollection) => collection
    ? collection.levels.filter((level) => level.image).sort((a, b) => a.level - b.level).slice(0, MAX_OBJECTS)
      .map((level) => makeLevelDefinition(collection, level, URL.createObjectURL(level.image!)))
    : []

  const addCollectionLevelToScene = async (collection: UserCollection, level: CollectionLevel) => {
    if (!level.image || !controller) return
    const imageSrc = URL.createObjectURL(level.image)
    const item = await controller.addDefinition(makeLevelDefinition(collection, level, imageSrc))
    if (!item) URL.revokeObjectURL(imageSrc)
    syncSceneState()
  }

  const resetScene = () => {
    const collection = collections.find((item) => item.id === selectedCollectionId)
    const definitions = definitionsForCollection(collection)
    if (controller) void controller.reset(definitions)
    else definitions.forEach((definition) => { if (definition.imageSrc) URL.revokeObjectURL(definition.imageSrc) })
    setSelected(null)
    syncSceneState()
  }

  useEffect(() => {
    if (!controller || !collectionsLoaded) return
    if (hydratedCollectionRef.current === (selectedCollectionId ?? null)) return
    hydratedCollectionRef.current = selectedCollectionId ?? null
    const collection = collectionsRef.current.find((item) => item.id === selectedCollectionId)
    const definitions = collection
      ? collection.levels.filter((level) => level.image).sort((a, b) => a.level - b.level).slice(0, MAX_OBJECTS)
        .map((level) => makeLevelDefinition(collection, level, URL.createObjectURL(level.image!)))
      : []
    void controller.reset(definitions)
    setSelected(null)
    syncSceneState()
  }, [controller, collectionsLoaded, selectedCollectionId, syncSceneState])

  const selectedCollection = collections.find((item) => item.id === selectedCollectionId)

  return <main className="editor-app">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><BallPlayMark /></div><div className="brand-name">ball<span>play</span><small>PHYSICS PLAYGROUND</small></div></div>
      <div className="topbar-divider" />
      <div className="document-title"><span className="live-dot" /><span>PNG-объекты · 9:16</span><span className="save-pill">Локально</span></div>
      <div className="topbar-actions">
        <div className="transport-group">
          <button className={`transport-button primary ${running ? '' : 'is-paused'}`} onClick={toggleRunning} disabled={!controller} aria-label={running ? 'Пауза' : 'Запуск'}><Icon name={running ? 'pause' : 'play'} size={17} /><span>{running ? 'Пауза' : 'Запуск'}</span></button>
          <button className="icon-button" onClick={resetScene} disabled={!controller} title="Перезапустить сцену" aria-label="Перезапустить"><Icon name="reset" /></button>
        </div>
        <div className="topbar-divider small" />
        <button className={`record-button ${recording ? 'recording' : ''}`} onClick={() => void toggleRecording()} disabled={!controller} title={recording ? 'Остановить и скачать запись' : 'Записать симуляцию'}><span className="record-indicator" />{recording ? 'Стоп и скачать' : 'Запись'}</button>
        {recordingError && <span className="recording-error" role="status">{recordingError}</span>}
        <div className="avatar">B</div>
      </div>
    </header>

    <div className="editor-layout">
      <aside className="left-panel panel">
        <div className="panel-heading"><span>ПРОЕКТ</span><button className="quiet-icon" title="Новый проект" onClick={resetScene}><Icon name="plus" size={15} /></button></div>
        <div className="project-card"><div className="project-thumb"><span className="thumb-orbit" /><span className="thumb-ball pink" /><span className="thumb-ball violet" /><span className="thumb-ball mint" /></div><div><strong>{selectedCollection?.name ?? 'Моя сцена'}</strong><span>Твои PNG · 9:16</span></div><span className="more-dots">···</span></div>

        <div className="section-label">РЕЖИМЫ</div>
        <nav className="mode-list" aria-label="Режимы симуляции">
          <button className="mode-item active"><span className="mode-icon active-mode"><Icon name="image" /></span><span><strong>Слияние</strong><small>Твои PNG-объекты</small></span><span className="mode-arrow">⌄</span></button>
          <button className="mode-item planned" title="Скоро"><span className="mode-icon"><Icon name="layers" /></span><span><strong>Спираль</strong><small>В разработке</small></span><span className="soon-tag">Скоро</span></button>
          <button className="mode-item planned" title="Скоро"><span className="mode-icon"><Icon name="polygon" /></span><span><strong>Лабиринт</strong><small>В разработке</small></span><span className="soon-tag">Скоро</span></button>
        </nav>

        <div className="section-label object-section-heading"><span>ОБЪЕКТЫ</span><span className="count-badge">{objectCount}</span></div>
        <div className="object-tools user-image-tools">
          {selectedCollection?.levels.filter((level) => level.image).sort((a, b) => a.level - b.level).map((level) => <button className="object-tool" key={level.id} onClick={() => addCollectionLevelToScene(selectedCollection, level)} title={`Добавить ещё один экземпляр: ${level.name}`}><span className="tool-icon image-tool"><Icon name="image" /></span><span><strong>{level.name}</strong><small>Уровень {level.level} · добавить копию</small></span><span className="tool-plus"><Icon name="plus" size={15} /></span></button>)}
          {!selectedCollection?.levels.some((level) => level.image) && <div className="user-images-empty">Загрузи PNG в разделе «Коллекции объектов». После загрузки объект начнёт падать сверху через вход арены.</div>}
        </div>

        <div className="left-panel-footer"><div className="help-dot">?</div><div><strong>BallPlay 0.1</strong><span>Создавай. Запускай. Залипай.</span></div><button className="quiet-icon" title="Справка"><span>↗</span></button></div>
      </aside>

      <section className="workspace">
        <div className="workspace-toolbar"><div className="breadcrumb"><span>Сцена</span><span className="crumb-slash">/</span><strong>Мои PNG</strong></div><div className="view-tools"><span className="scene-size"><span className="portrait-icon" /> 9:16</span><span className="toolbar-separator" /><span className="zoom-value">100%</span><button className="zoom-button" title="Масштаб по размеру экрана">⊡</button><button className="zoom-button" title="Очистить сцену" onClick={clearScene}><Icon name="close" size={15} /></button></div></div>
          <div className="canvas-workspace">
            {recordedVideoUrl && <video ref={recordedVideoRef} className="recorded-preview" src={recordedVideoUrl} controls playsInline onLoadedMetadata={(event) => setRecordedDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setRecordedCurrentTime(event.currentTarget.currentTime)} onEnded={() => setRecordedCurrentTime(recordedDuration)} />}
          <div className="stage-wrap"><div className="stage-glow" /><SimulationViewport sound={sound} collections={collections} onController={registerController} onSelectObject={registerSelection} onSceneChanged={syncSceneState} /><div className="stage-top-label"><span className="stage-live" /> LIVE PREVIEW</div><div className="stage-watermark" aria-hidden="true">BALLPLAY.RU</div><div className="stage-bottom-label"><span>360 × 640</span><span>·</span><span>9:16</span></div></div>
          <div className="canvas-caption"><span className="caption-icon"><Icon name="sparkle" size={15} /></span><span>В сцене только загруженные PNG <i>·</i> одинаковые уровни сливаются</span></div>
        </div>
        <div className="timeline-bar"><button className={`timeline-play ${recordedVideoUrl ? '' : (running ? '' : 'paused')}`} onClick={recordedVideoUrl ? toggleRecordedPlayback : toggleRunning} aria-label={recordedVideoUrl ? 'Воспроизвести запись' : (running ? 'Пауза' : 'Запуск')}><Icon name={recordedVideoUrl && !recordedVideoRef.current?.paused ? 'pause' : 'play'} size={13} /></button><div className="timeline-track"><div className="timeline-fill" style={{ width: recordedDuration ? `${(recordedCurrentTime / recordedDuration) * 100}%` : undefined }} /><input aria-label="Перемотка записи" className="timeline-seek" type="range" min="0" max={recordedDuration || 1} step="0.01" value={recordedCurrentTime} disabled={!recordedVideoUrl} onChange={(event) => { const value = Number(event.target.value); setRecordedCurrentTime(value); if (recordedVideoRef.current) recordedVideoRef.current.currentTime = value }} /></div><span className="timeline-time">{recordedVideoUrl ? formatTime(recordedCurrentTime) : 'LIVE'} <span>/</span> {recordedVideoUrl ? formatTime(recordedDuration) : '∞'}</span><span className="timeline-label">{recordedVideoUrl ? 'ПРОСМОТР ЗАПИСИ' : 'СИМУЛЯЦИЯ В РЕАЛЬНОМ ВРЕМЕНИ'}</span></div>
      </section>

      <aside className="right-panel panel">
        <div className="inspector-tabs"><button className={`inspector-tab ${inspectorTab === 'settings' ? 'active' : ''}`} onClick={() => setInspectorTab('settings')}>Настройки</button><button className={`inspector-tab ${inspectorTab === 'layers' ? 'active' : ''}`} onClick={() => setInspectorTab('layers')}>Слои <span className="count-badge small-count">{objectCount}</span></button><button className="inspector-menu" onClick={resetScene}>···</button></div>
        {inspectorTab === 'layers' ? <div className="layer-list">{layerItems.length ? [...layerItems].reverse().map((item) => <button key={item.id} className={`layer-item ${selected?.id === item.id ? 'chosen' : ''}`} onClick={() => { setSelected(item); controller?.setSelected(item.id); setInspectorTab('settings') }}><span className="layer-color image-layer-dot" style={{ backgroundColor: `#${item.color.toString(16).padStart(6, '0')}` }} /><span className="layer-name">{item.label}</span><span className="layer-kind">PNG · L{item.level}</span></button>) : <div className="empty-selection">Сцена пуста. Загрузи PNG в коллекцию справа.</div>}</div> : <div className="inspector-scroll">
          <CollectionEditor collections={collections} selectedId={selectedCollectionId} onSelect={setSelectedCollectionId} onCreate={createCollection} onDelete={deleteCollection} onRename={(id, name) => commitCollection(id, (collection) => ({ ...collection, name: name || 'Без названия' }))} onAddLevel={addLevel} onDeleteLevel={deleteLevel} onUpdateLevel={updateLevel} onImage={uploadCollectionImage} onRemoveImage={removeCollectionImage} onSound={uploadCollectionSound} onRemoveSound={removeCollectionSound} onTestSound={(id, level) => void sound.testMergeSound(id, level)} onAddToScene={addCollectionLevelToScene} />
          <section className="inspector-section"><div className="inspector-title"><span className="title-icon physics-icon"><Icon name="sparkle" size={15} /></span><div><h2>Физика сцены</h2><p>Общие параметры симуляции</p></div><button className="reset-tiny" title="Сбросить параметры" onClick={() => { setGravity(1); setRestitution(DEFAULT_RESTITUTION); setSpeed(0.5); applySettings({ gravity: 1, restitution: DEFAULT_RESTITUTION, speed: 0.5 }) }}><Icon name="reset" size={14} /></button></div>
            <RangeControl label="Гравитация" value={gravity} min={0} max={2.5} step={0.05} onChange={(value) => { setGravity(value); applySettings({ gravity: value }) }} />
            <RangeControl label="Упругость" value={restitution} min={0} max={1} step={0.01} onChange={(value) => { setRestitution(value); applySettings({ restitution: value }) }} />
            <RangeControl label="Скорость времени" value={speed} min={0.25} max={2} step={0.05} suffix="×" onChange={(value) => { setSpeed(value); applySettings({ speed: value }) }} />
          </section>

          <section className="inspector-section object-inspector"><div className="inspector-title"><span className="title-icon selected-icon"><Icon name="ball" size={15} /></span><div><h2>Выбранный объект</h2><p>{selected ? selected.label : 'Объект не выбран'}</p></div></div>
            {selected ? <>
              {selected.kind !== 'box' && <RangeControl label="Размер" value={selected.radius ?? 20} min={8} max={48} step={1} suffix=" px" onChange={(value) => updateSelected({ radius: value })} />}
              {selected.kind === 'box' && <RangeControl label="Ширина" value={selected.width ?? 80} min={32} max={180} step={2} suffix=" px" onChange={(value) => updateSelected({ width: value })} />}
              {!selected.isStatic && <RangeControl label="Масса" value={selected.mass ?? 1} min={0.2} max={5} step={0.1} suffix=" кг" onChange={(value) => updateSelected({ mass: value })} />}
              {!selected.isStatic && <RangeControl label="Отскок объекта" value={selected.restitution ?? restitution} min={0} max={1} step={0.01} onChange={(value) => updateSelected({ restitution: value })} />}
              <div className="property-row"><span>Форма</span><span className="property-value"><span className="shape-dot" />{selected.kind === 'circle' ? 'Круг' : selected.kind === 'polygon' ? 'Многоугольник' : selected.kind === 'image' ? 'Изображение' : 'Прямоугольник'}</span></div>
              <label className="color-row"><span>Цвет объекта</span><span className="color-picker"><input type="color" value={`#${selected.color.toString(16).padStart(6, '0')}`} onChange={(event) => updateSelected({ color: Number.parseInt(event.target.value.slice(1), 16) })} /><span>{`#${selected.color.toString(16).padStart(6, '0').toUpperCase()}`}</span></span></label>
            </> : <div className="empty-selection">Загрузи свою PNG в выбранную коллекцию — она появится в сцене, и здесь можно будет настроить её физику.</div>}
          </section>

          <section className="inspector-section sound-section"><div className="inspector-title"><span className="title-icon audio-icon"><Icon name="sound" size={15} /></span><div><h2>Звук слияния</h2><p>Только для одинаковых уровней</p></div><button className={`toggle ${soundEnabled ? 'on' : ''}`} onClick={() => changeSoundEnabled(!soundEnabled)} role="switch" aria-checked={soundEnabled} aria-label="Включить звук слияния"><span /></button></div>
            <RangeControl label="Общая громкость" value={volume} min={0} max={1} step={0.01} onChange={changeVolume} />
            <div className="audio-note"><span>♪</span> Обычные столкновения и удары о стены беззвучны. Звук запускается один раз только после успешного слияния двух одинаковых объектов.</div>
          </section>
        </div>}
      </aside>
    </div>
  </main>
}

type PaymentPlanCode = 'week' | 'threeDays' | 'day'
type PaymentIntent = { invoiceId: string; accountId: string; email: string; publicId: string; amount: number; plan: { period: number; amount: number } }
type CloudPaymentsBlocksOptions = { publicTerminalId: string; description: string; paymentSchema: 'Single'; amount: number; currency: string; language: string; externalId: string; accountId: string; tokenize: true; receiptEmail?: string }
type CloudPaymentsBlocksCustomization = { appearance: { colors: { primaryButtonColor: string; primaryHoverButtonColor: string; primaryButtonTextColor: string; primaryButtonHoverTextColor: string; activeInputColor: string; inputBackground: string; inputColor: string; inputBorderColor: string; titleColor: string; textColor: string; errorColor: string; skeletonBackground: string }; borders: { radius: string } }; components: { paymentButton: { fontSize: string }; paymentForm: { labelFontSize: string; activeLabelFontSize: string; fontSize: string } } }
type CloudPaymentsBlocksApp = { mount: (element: HTMLElement) => void; unmount: () => void; on: (event: 'success' | 'fail', callback: (result: unknown) => void) => void }
function LandingPage() {
  const [checkoutVisible, setCheckoutVisible] = useState(false)
  const [consentCheckboxesEnabled, setConsentCheckboxesEnabled] = useState(true)
  const checkoutSectionRef = useRef<HTMLElement | null>(null)
  const [accepted, setAccepted] = useState({ terms: false, personalData: false, recurring: false })
  const paymentPlan: PaymentPlanCode = 'week'
  const [accountMode, setAccountMode] = useState<'register' | 'login'>('register')
  const [accountEmail, setAccountEmail] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [paymentMessage, setPaymentMessage] = useState('')
  const [paymentIntent, setPaymentIntent] = useState<PaymentIntent | null>(null)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)
  const [cloudPaymentsReady, setCloudPaymentsReady] = useState(false)
  const paymentBlocksElementRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void fetch('/api/public/settings', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((settings) => {
        if (typeof settings?.consentPopupEnabled === 'boolean') setConsentCheckboxesEnabled(settings.consentPopupEnabled)
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (window.location.pathname !== '/') return
    const key = 'ballplay-homepage-view-recorded'
    try {
      if (window.sessionStorage.getItem(key)) return
      window.sessionStorage.setItem(key, '1')
    } catch { /* Count this page load if browser storage is unavailable. */ }
    void fetch('/api/analytics/homepage', { method: 'POST', keepalive: true }).catch(() => undefined)
  }, [])
  useEffect(() => {
    const checkoutSection = checkoutSectionRef.current
    if (!checkoutSection || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(([entry]) => setCheckoutVisible(entry.isIntersecting), { rootMargin: '-12% 0px -12% 0px' })
    observer.observe(checkoutSection)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-cloudpayments-blocks]')
    if (existing) {
      if ((window as Window & { cp?: { PaymentBlocks?: unknown } }).cp?.PaymentBlocks) setCloudPaymentsReady(true)
      else existing.addEventListener('load', () => setCloudPaymentsReady(true), { once: true })
    } else {
      const script = document.createElement('script'); script.src = 'https://widget.cloudpayments.ru/bundles/paymentblocks.js'; script.async = true; script.dataset.cloudpaymentsBlocks = 'true'; script.onload = () => setCloudPaymentsReady(true); script.onerror = () => setPaymentMessage('Не удалось загрузить кассу CloudPayments. Обновите страницу и попробуйте ещё раз.'); document.head.appendChild(script)
    }
  }, [])
  useEffect(() => {
    const mountElement = paymentBlocksElementRef.current
    if (!paymentIntent || !cloudPaymentsReady || !mountElement || paymentConfirmed) return
    const PaymentBlocks = (window as Window & { cp?: { PaymentBlocks?: new (options: CloudPaymentsBlocksOptions, customization?: CloudPaymentsBlocksCustomization) => CloudPaymentsBlocksApp } }).cp?.PaymentBlocks
    if (!PaymentBlocks) { setPaymentMessage('Встроенная касса CloudPayments не загрузилась. Обновите страницу и попробуйте ещё раз.'); return }
    const recurring = paymentIntent.plan
    const blocks = new PaymentBlocks({
      publicTerminalId: paymentIntent.publicId,
      description: `BallPlay: 1 ₽ за первый день, затем ${recurring.amount} ₽ за ${recurring.period} дн.`,
      paymentSchema: 'Single', amount: paymentIntent.amount, currency: 'RUB', language: 'ru-RU',
      externalId: paymentIntent.invoiceId,
      accountId: paymentIntent.accountId,
      tokenize: true, ...(paymentIntent.email ? { receiptEmail: paymentIntent.email } : {}),
    }, {
      appearance: {
        colors: {
          primaryButtonColor: '#F39BB5', primaryHoverButtonColor: '#E982A2',
          primaryButtonTextColor: '#FFFFFF', primaryButtonHoverTextColor: '#FFFFFF',
          activeInputColor: '#E982A2', inputBackground: '#FFFFFF', inputColor: '#292929',
          inputBorderColor: '#D9D9DD', titleColor: '#292929', textColor: '#292929',
          errorColor: '#C83E53', skeletonBackground: '#F5F5F5',
        },
        borders: { radius: '24px' },
      },
      components: {
        paymentButton: { fontSize: '15px' },
        paymentForm: { labelFontSize: '13px', activeLabelFontSize: '12px', fontSize: '14px' },
      },
    })
    blocks.on('success', () => setPaymentMessage('Платёж принят CloudPayments. Подтверждаем оплату…'))
    blocks.on('fail', () => setPaymentMessage('CloudPayments не провёл платёж. Проверьте данные карты и попробуйте снова.'))
    blocks.mount(mountElement)
    return () => blocks.unmount()
  }, [paymentIntent, cloudPaymentsReady, paymentConfirmed])
  useEffect(() => {
    if (!paymentIntent || paymentConfirmed) return
    let stopped = false
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/payment/status/${paymentIntent.invoiceId}`, { cache: 'no-store' })
        const data = response.ok ? await response.json() : null
        if (data?.status === 'paid' && !stopped) { setPaymentConfirmed(true); setAccountEmail(paymentIntent.email); setPaymentMessage('Оплата 1 ₽ подтверждена. Теперь создайте аккаунт, чтобы открыть редактор.') }
      } catch { /* Retry while checkout stays open. */ }
    }
    void checkPayment()
    const timer = window.setInterval(() => { void checkPayment() }, 3000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [paymentIntent, paymentConfirmed])
  const startAccess = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    document.getElementById('subscribe')?.scrollIntoView({ behavior: 'smooth' })
  }
  const createPaymentIntent = async (consents = accepted) => {
    if (!consents.terms || !consents.personalData || !consents.recurring) {
      setPaymentMessage('Отметьте все три обязательных согласия, чтобы перейти к оплате.')
      return
    }
    setPaymentBusy(true)
    try {
      const response = await fetch('/api/payment/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: paymentPlan, consents }) })
      const intent = await response.json()
      if (!response.ok) throw new Error(intent.error || 'Не удалось начать оплату.')
      setPaymentIntent(intent as PaymentIntent)
    } catch (error) { setPaymentMessage(error instanceof Error ? error.message : 'Не удалось начать оплату.') }
    finally { setPaymentBusy(false) }
  }
  const submitAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setPaymentBusy(true); setPaymentMessage('')
    try {
      if (!paymentConfirmed || !paymentIntent) throw new Error('Сначала оплатите 1 ₽ в форме CloudPayments.')
      const response = await fetch(`/api/auth/${accountMode}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: accountEmail, password: accountPassword, invoiceId: paymentIntent.invoiceId }) })
      const auth = await response.json()
      if (!response.ok) throw new Error(auth.error || 'Не удалось войти.')
      window.location.assign('/editor')
    } catch (error) { setPaymentMessage(error instanceof Error ? error.message : 'Не удалось начать оплату.') }
    finally { setPaymentBusy(false) }
  }
  return <main className="landing-page">
    <nav className="landing-nav"><a className="landing-brand" href="#top"><span className="landing-mark"><BallPlayMark /></span> ball<span>play</span></a><a className="landing-nav-link" href="#features">Как это работает</a><a className="landing-nav-cta" href="#subscribe" onClick={startAccess}>Попробовать BallPlay <span>↗</span></a></nav>
    <section className="landing-hero" id="top">
      <div className="landing-copy"><div className="landing-eyebrow"><span /> СИМУЛЯЦИИ ДЛЯ ВЕРТИКАЛЬНЫХ ВИДЕО</div><h1>Преврати свои картинки в <em>залипательное видео</em></h1><p>Загрузи PNG-персонажей, настрой физику и слияния, а затем запиши готовую симуляцию в формате 9:16 — прямо в браузере.</p><a className="landing-primary" href="#subscribe" onClick={startAccess}>Попробовать BallPlay <span>→</span></a></div>
      <div className="landing-preview" aria-label="Превью редактора BallPlay"><div className="preview-top"><span className="preview-dot" /><span className="preview-dot" /><span className="preview-dot" /><span className="preview-title">ballplay / симуляция 01</span><span className="preview-live">● LIVE</span></div><div className="preview-scene"><div className="preview-arena"><span className="preview-object object-one">🐱</span><span className="preview-object object-two">🐸</span><span className="preview-object object-three">🐱</span><span className="preview-spark">✦</span></div><div className="preview-caption">ТВОЯ ИДЕЯ — ТВОЯ СИМУЛЯЦИЯ</div></div><div className="preview-controls"><span>◉ Запись</span><span>Ⅱ Пауза</span><span>⟳ Сброс</span><div className="preview-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div></div>
    </section>
    <section className="landing-features" id="features"><div className="landing-section-heading"><span>ОТ ИДЕИ ДО ГОТОВОГО РОЛИКА</span><h2>Три шага — и симуляция готова</h2></div><div className="landing-feature-grid"><article><b>01</b><h3>Добавь свои картинки</h3><p>Загрузи PNG-персонажей и собери коллекцию уровней для своей игры.</p></article><article><b>02</b><h3>Настрой поведение</h3><p>Выбери физику, скорость, размер и правила слияния объектов.</p></article><article><b>03</b><h3>Запиши видео</h3><p>Запусти сцену, выбери удачный момент и сохрани вертикальный ролик 9:16.</p></article></div><a className="landing-inline-cta" href="#subscribe" onClick={startAccess}>Открыть редактор <span>→</span></a></section>
    <section className="landing-subscribe" id="subscribe" ref={checkoutSectionRef}><div className="payment-copy"><div className="landing-eyebrow"><span /> ДОСТУП К РЕДАКТОРУ</div><h2>Создавай свои видео<br />уже <em>сегодня</em></h2><p className="payment-intro">Оформи доступ, создай аккаунт после оплаты и переходи к симуляциям.</p></div><div className="payment-card">{!paymentConfirmed && <>{!paymentIntent && <div className="checkout-consents"><p className="checkout-consent-heading">Перед оплатой подтвердите условия</p>{consentCheckboxesEnabled ? <><label className="checkout-consent"><input type="checkbox" checked={accepted.terms} onChange={(event) => setAccepted((current) => ({ ...current, terms: event.target.checked }))} /><span>Принимаю <a href="/terms" target="_blank" rel="noreferrer">условия использования</a>.</span></label><label className="checkout-consent"><input type="checkbox" checked={accepted.personalData} onChange={(event) => setAccepted((current) => ({ ...current, personalData: event.target.checked }))} /><span>Даю согласие на обработку персональных данных согласно <a href="/privacy" target="_blank" rel="noreferrer">политике обработки персональных данных</a>.</span></label><label className="checkout-consent"><input type="checkbox" checked={accepted.recurring} onChange={(event) => setAccepted((current) => ({ ...current, recurring: event.target.checked }))} /><span><strong>Отдельно соглашаюсь с условиями подписки и рекуррентных платежей:</strong> 1 ₽ за первый день, затем <strong>699 ₽ каждые 7 дней</strong> с автопродлением до отмены. Отменить подписку и остановить будущие списания можно в любой момент по адресу <a href="mailto:cikatuh666@gmail.com">cikatuh666@gmail.com</a>. По вопросам возврата уже списанных средств напишите туда же; обращения рассматриваются по правилам <a href="/tariffs" target="_blank" rel="noreferrer">возврата и тарификации</a> и законодательству РФ.</span></label><button className="payment-consent-submit" type="button" disabled={!accepted.terms || !accepted.personalData || !accepted.recurring || paymentBusy} onClick={() => void createPaymentIntent()}>{paymentBusy ? 'Подготавливаем оплату…' : 'Перейти к оплате 1 ₽'}</button></> : <><div className="checkout-consent-summary"><p>Оформляется подписка: <strong>1 ₽ за первый день, затем 699 ₽ каждые 7 дней</strong>, с автопродлением до отмены.</p><p>Подписку можно отменить в любой момент, написав на <a href="mailto:cikatuh666@gmail.com">cikatuh666@gmail.com</a>. По вопросам возврата обращайтесь туда же; применяются <a href="/tariffs" target="_blank" rel="noreferrer">правила тарификации и возврата</a> и законодательство РФ.</p><p>Нажимая кнопку ниже, вы принимаете <a href="/terms" target="_blank" rel="noreferrer">условия использования</a> и <a href="/privacy" target="_blank" rel="noreferrer">политику обработки персональных данных</a>, даёте согласие на обработку персональных данных и отдельно соглашаетесь на подписку и регулярные списания на указанных условиях.</p></div><button className="payment-consent-submit" type="button" disabled={paymentBusy} onClick={() => void createPaymentIntent({ terms: true, personalData: true, recurring: true })}>{paymentBusy ? 'Подготавливаем оплату…' : 'Согласиться и перейти к оплате 1 ₽'}</button></>}</div>}{paymentIntent && <div className="cloudpayments-embed" ref={paymentBlocksElementRef} aria-label="Официальная встроенная касса CloudPayments"/>}</>}{paymentConfirmed && <form className="checkout-account-form" onSubmit={submitAccount}><h3>Оплата подтверждена</h3><p>Создайте аккаунт, чтобы привязать подписку и открыть редактор.</p><label>E-mail<input type="email" autoComplete="email" required value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} /></label><label>Пароль<input type="password" autoComplete={accountMode === 'register' ? 'new-password' : 'current-password'} minLength={8} required value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} /></label>{paymentMessage && <p className="payment-message" role="alert">{paymentMessage}</p>}<button className="payment-submit" type="submit" disabled={paymentBusy}>{paymentBusy ? 'Подождите…' : accountMode === 'register' ? 'Создать аккаунт' : 'Войти и привязать оплату'}</button><button className="account-switch" type="button" onClick={() => setAccountMode(accountMode === 'register' ? 'login' : 'register')}>{accountMode === 'register' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Создать'}</button></form>}{paymentMessage && !paymentConfirmed && <p className="payment-message" role="status">{paymentMessage}</p>}</div></section>
    {!checkoutVisible && <a className="mobile-access-cta" href="#subscribe" onClick={startAccess}>Попробовать BallPlay <span>→</span></a>}
    <footer className="landing-footer"><a className="landing-brand" href="#top"><span className="landing-mark"><BallPlayMark /></span> ball<span>play</span></a><span>Твори. Запускай. Залипай.</span><a className="landing-legal-link" href="/terms">Условия использования</a><a className="landing-legal-link" href="/tariffs">Тарификация</a><span>© BallPlay</span></footer>
  </main>
}

type AdminUser = { id: string; email: string; created_at: string; subscription_status: string; last_payment_status: string | null }
type ReferralPartner = { id: string; username: string; display_name: string; referral_code: string; active: boolean; visits: number; registrations: number; renewals: number; paying_customers: number; earned_minor: number; paid_minor: number; due_minor: number }
type HomepageAnalytics = { total: number; days: { date: string; views: number }[] }
const rubles = (minor: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(minor / 100)
const formatAnalyticsDate = (value: string) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return '—'
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
}

function EditorGate() {
  const [state, setState] = useState<'checking' | 'allowed' | 'denied'>('checking')
  useEffect(() => { void fetch('/api/auth/me', { credentials: 'include' }).then((response) => response.ok ? response.json() : null).then((data) => setState(data?.subscriptionStatus === 'active' ? 'allowed' : 'denied')).catch(() => setState('denied')) }, [])
  if (state === 'checking') return <main className="admin-page"><div className="admin-card">Проверяем доступ…</div></main>
  if (state === 'denied') return <main className="admin-page"><div className="admin-card"><a className="landing-brand" href="/"><span className="landing-mark"><BallPlayMark /></span> ball<span>play</span></a><p className="admin-kicker">ДОСТУП К РЕДАКТОРУ</p><h1>Нужна активная подписка</h1><p>Войдите в аккаунт с активной подпиской или оформите доступ на главной странице.</p><a className="landing-primary" href="/#subscribe">Перейти к тарифам <span>→</span></a></div></main>
  return <EditorApp />
}

function ReferralPartnerPanel({ displayName, onLogout, api }: { displayName?: string; onLogout: () => void; api: (url: string, init?: RequestInit) => Promise<any> }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => { try { setData(await api('/api/admin/referral/dashboard')); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить статистику.') } }, [api])
  useEffect(() => { void load() }, [load])
  const metric = (title: string, value: string) => <article className="referral-metric"><span>{title}</span><strong>{value}</strong></article>
  return <main className="admin-page"><header className="admin-header"><a className="landing-brand" href="/"><span className="landing-mark"><BallPlayMark /></span> ball<span>play</span></a><div><span>Кабинет партнёра · {displayName || data?.display_name || ''}</span><button onClick={() => void load()}>Обновить</button><button onClick={onLogout}>Выйти</button></div></header><section className="admin-content referral-content"><p className="admin-kicker">РЕФЕРАЛЬНАЯ ПРОГРАММА</p><h1>Ваша статистика</h1>{error && <p className="admin-error">{error}</p>}{data && <><section className="referral-link-card"><div><span>Ваша ссылка</span><strong>{data.referralUrl}</strong><small>50% от каждого успешного продления подписки</small></div><button onClick={() => void navigator.clipboard?.writeText(data.referralUrl)}>Скопировать</button></section><div className="referral-metrics">{metric('Переходы', new Intl.NumberFormat('ru-RU').format(Number(data.visits)))}{metric('Регистрации', new Intl.NumberFormat('ru-RU').format(Number(data.registrations)))}{metric('Клиенты с оплатой', new Intl.NumberFormat('ru-RU').format(Number(data.paying_customers)))}{metric('Успешные продления', new Intl.NumberFormat('ru-RU').format(Number(data.renewals)))}{metric('Начислено', rubles(Number(data.earned_minor)))}{metric('Выплачено', rubles(Number(data.paid_minor)))}{metric('К выплате', rubles(Number(data.due_minor)))}</div><p className="admin-analytics-note">Статистика учитывает переходы по вашей ссылке и начисления за продления. Данные других партнёров и личные данные клиентов вам недоступны.</p></>}</section></main>
}

function AdminPanel() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [consentPopupEnabled, setConsentPopupEnabled] = useState(true)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [homepageAnalytics, setHomepageAnalytics] = useState<HomepageAnalytics | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [role, setRole] = useState<'owner' | 'partner' | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [referrals, setReferrals] = useState<ReferralPartner[]>([])
  const [partnerForm, setPartnerForm] = useState({ username: '', displayName: '', password: '' })
  const api = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...init?.headers } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.')
    return result
  }, [])
  const loadUsers = useCallback(async () => {
    setLoading(true); setError('')
    try { const result = await api('/api/admin/users'); setUsers(result.users) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Ошибка загрузки пользователей.') }
    finally { setLoading(false) }
  }, [])
  const loadHomepageAnalytics = useCallback(async () => {
    setAnalyticsLoading(true)
    try { setHomepageAnalytics(await api('/api/admin/analytics/homepage')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить статистику.') }
    finally { setAnalyticsLoading(false) }
  }, [])
  useEffect(() => {
    void api('/api/admin/me').then(async (me) => { setAuthenticated(true); setRole(me.role); setDisplayName(me.displayName || ''); if (me.role === 'owner') { const [_, settings] = await Promise.all([loadUsers(), api('/api/admin/settings'), loadHomepageAnalytics()]); setConsentPopupEnabled(settings.consentPopupEnabled); setReferrals((await api('/api/admin/referrals')).partners) } }).catch(() => undefined).finally(() => setChecking(false))
  }, [loadUsers, loadHomepageAnalytics])
  const login = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try { const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) }); setAuthenticated(true); setRole(result.role); setDisplayName(result.displayName || ''); setPassword(''); if (result.role === 'owner') { const [_, settings] = await Promise.all([loadUsers(), api('/api/admin/settings'), loadHomepageAnalytics()]); setConsentPopupEnabled(settings.consentPopupEnabled); setReferrals((await api('/api/admin/referrals')).partners) } }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось войти.') }
  }
  const changeSubscription = async (user: AdminUser, status: string) => {
    try { await api(`/api/admin/users/${user.id}/subscription`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadUsers() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить подписку.') }
  }
  const saveConsentPopupSetting = async (enabled: boolean) => {
    setSettingsLoading(true); setError('')
    try { const result = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ consentPopupEnabled: enabled }) }); setConsentPopupEnabled(result.consentPopupEnabled) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройку.') }
    finally { setSettingsLoading(false) }
  }
  const loadReferrals = async () => { try { setReferrals((await api('/api/admin/referrals')).partners) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить партнёров.') } }
  const createPartner = async (event: FormEvent) => { event.preventDefault(); setError(''); try { await api('/api/admin/referrals', { method: 'POST', body: JSON.stringify(partnerForm) }); setPartnerForm({ username: '', displayName: '', password: '' }); await loadReferrals() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать партнёра.') } }
  const togglePartner = async (partner: ReferralPartner) => { try { await api(`/api/admin/referrals/${partner.id}`, { method: 'PATCH', body: JSON.stringify({ active: !partner.active }) }); await loadReferrals() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить партнёра.') } }
  const payPartner = async (partner: ReferralPartner) => { try { await api(`/api/admin/referrals/${partner.id}/payout`, { method: 'POST', body: JSON.stringify({}) }); await loadReferrals() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отметить выплату.') } }
  const logout = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => undefined); setAuthenticated(false); setRole(null); setUsers([]); setReferrals([]) }
  if (checking) return <main className="admin-page"><div className="admin-card">Проверка сессии…</div></main>
  if (!authenticated) return <main className="admin-page"><form className="admin-card admin-login" onSubmit={login}><a className="landing-brand" href="/"><span className="landing-mark"><BallPlayMark /></span> ball<span>play</span></a><p className="admin-kicker">ПАНЕЛЬ УПРАВЛЕНИЯ</p><h1>Вход</h1><label>Логин<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="admin-error">{error}</p>}<button className="admin-primary">Войти</button></form></main>
  if (role === 'partner') return <ReferralPartnerPanel displayName={displayName} onLogout={() => void logout()} api={api} />
  const filtered = users.filter((user) => user.email.toLowerCase().includes(query.toLowerCase()))
  const maxHomepageViews = Math.max(0, ...(homepageAnalytics?.days.map((day) => day.views) || []))
  return <main className="admin-page"><header className="admin-header"><a className="landing-brand" href="/"><span className="landing-mark"><BallPlayMark /></span> ball<span>play</span></a><div><span>Администрирование</span><button onClick={() => { void loadUsers(); void loadHomepageAnalytics(); void loadReferrals() }} disabled={loading || analyticsLoading}>Обновить</button><button onClick={() => void logout()}>Выйти</button></div></header><section className="admin-content"><div className="admin-heading"><div><p className="admin-kicker">ПОЛЬЗОВАТЕЛИ И ДОСТУП</p><h1>Панель управления</h1><p>Всего аккаунтов: <b>{users.length}</b></p></div><input className="admin-search" placeholder="Найти по e-mail" value={query} onChange={(event) => setQuery(event.target.value)} /></div>{error && <p className="admin-error">{error}</p>}<section className="admin-analytics-card"><div className="admin-analytics-summary"><p className="admin-kicker">ПОСЕЩЕНИЯ ГЛАВНОЙ</p><h2>{homepageAnalytics ? new Intl.NumberFormat('ru-RU').format(homepageAnalytics.total) : analyticsLoading ? '…' : '—'}</h2><p>Всего просмотров страницы</p></div><div className="admin-analytics-days"><h3>Последние 30 дней</h3>{homepageAnalytics?.days.map((day) => <div className="admin-analytics-day" key={day.date}><time>{formatAnalyticsDate(day.date)}</time><div className="admin-analytics-bar"><span style={{ width: `${maxHomepageViews ? day.views / maxHomepageViews * 100 : 0}%` }} /></div><b>{new Intl.NumberFormat('ru-RU').format(day.views)}</b></div>)}</div><p className="admin-analytics-note">Считаются просмотры главной по одному разу за вкладку. Имена и IP-адреса не сохраняются.</p></section><section className="admin-settings-card"><div><p className="admin-kicker">ГЛАВНАЯ СТРАНИЦА</p><h2>Чекбоксы перед оплатой</h2><p>Когда включено, посетитель отдельно отмечает согласия. Когда выключено, чекбоксы скрыты, а условия показаны текстом; явное согласие оформляется нажатием кнопки перехода к оплате.</p></div><label className="admin-switch"><input type="checkbox" checked={consentPopupEnabled} disabled={settingsLoading} onChange={(event) => void saveConsentPopupSetting(event.target.checked)} /><span>{settingsLoading ? 'Сохраняем…' : consentPopupEnabled ? 'Включено' : 'Выключено'}</span></label></section><section className="referral-admin-card"><div className="referral-admin-heading"><div><p className="admin-kicker">ПАРТНЁРСКАЯ ПРОГРАММА</p><h2>Реферальные партнёры</h2><p>Комиссия — 50% от суммы каждого продления. Выплаты отмечаются вручную после перевода.</p></div></div><form className="referral-create-form" onSubmit={createPartner}><label>Имя партнёра<input value={partnerForm.displayName} onChange={(event) => setPartnerForm({ ...partnerForm, displayName: event.target.value })} required /></label><label>Логин<input value={partnerForm.username} onChange={(event) => setPartnerForm({ ...partnerForm, username: event.target.value })} minLength={3} maxLength={40} required /></label><label>Временный пароль<input type="password" value={partnerForm.password} onChange={(event) => setPartnerForm({ ...partnerForm, password: event.target.value })} minLength={12} required /></label><button className="admin-primary">Создать партнёра</button></form><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Партнёр</th><th>Ссылка</th><th>Переходы</th><th>Регистрации</th><th>Платят клиентов</th><th>Продления</th><th>Начислено</th><th>Выплачено</th><th>К выплате</th><th>Действия</th></tr></thead><tbody>{referrals.map((partner) => <tr key={partner.id}><td>{partner.display_name}<br /><small>{partner.username}</small></td><td><a href={`/?ref=${partner.referral_code}`} target="_blank" rel="noreferrer">/?ref={partner.referral_code}</a></td><td>{partner.visits}</td><td>{partner.registrations}</td><td>{partner.paying_customers}</td><td>{partner.renewals}</td><td>{rubles(Number(partner.earned_minor))}</td><td>{rubles(Number(partner.paid_minor))}</td><td>{rubles(Number(partner.due_minor))}</td><td><button className="referral-action" onClick={() => window.confirm(`После фактического перевода ${rubles(Number(partner.due_minor))} нажмите OK, чтобы отметить выплату.`) && void payPartner(partner)} disabled={!Number(partner.due_minor)}>Отметить выплату</button><button className="referral-action" onClick={() => void togglePartner(partner)}>{partner.active ? 'Отключить' : 'Включить'}</button></td></tr>)}{!referrals.length && <tr><td colSpan={10} className="admin-empty">Партнёров пока нет</td></tr>}</tbody></table></div></section><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Пользователь</th><th>Создан</th><th>Последняя оплата</th><th>Подписка</th><th>Управление</th></tr></thead><tbody>{filtered.map((user) => <tr key={user.id}><td>{user.email}</td><td>{new Date(user.created_at).toLocaleDateString('ru-RU')}</td><td>{user.last_payment_status || 'Нет платежей'}</td><td><span className={`admin-status ${user.subscription_status}`}>{user.subscription_status}</span></td><td><select aria-label={`Подписка ${user.email}`} value={user.subscription_status} onChange={(event) => void changeSubscription(user, event.target.value)}><option value="inactive">Неактивна</option><option value="active">Активна</option><option value="expired">Истекла</option><option value="cancelled">Отменена</option></select></td></tr>)}{filtered.length === 0 && <tr><td colSpan={5} className="admin-empty">{loading ? 'Загружаю…' : 'Пользователи не найдены'}</td></tr>}</tbody></table></div></section></main>
}

export default function App() {
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ref')
    if (code) void fetch('/api/referral/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ code }) }).catch(() => undefined)
  }, [])
  if (window.location.pathname === '/terms') return <TermsPage />
  if (window.location.pathname === '/privacy') return <PrivacyPage />
  if (window.location.pathname === '/tariffs') return <TariffsPage />
  if (window.location.pathname === '/admin') return <AdminPanel />
  const isEditorRoute = window.location.pathname === '/editor'
  if (isEditorRoute) return <EditorGate />
  return <LandingPage />
}
