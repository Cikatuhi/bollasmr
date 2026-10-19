import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AudioEngine } from './audio/AudioEngine'
import SimulationViewport, { type SceneController } from './components/SimulationViewport'
import CollectionEditor from './components/CollectionEditor'
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

export default function App() {
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
    const firstLevelDefinitions = collection
      ? collection.levels.filter((level) => level.image && level.level === 1).map((level) => makeLevelDefinition(collection, level, URL.createObjectURL(level.image!)))
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
      videoStream = canvas.captureStream(60)
      stream = new MediaStream([...videoStream.getVideoTracks(), audioTrack])
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recordedChunksRef.current = []
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunksRef.current.push(event.data) }
      recorder.onerror = () => {
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
        link.download = `ballstudio-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
        link.click()
        window.setTimeout(() => { if (recordedVideoUrl !== url) URL.revokeObjectURL(url) }, 60_000)
      }
      recorderRef.current = recorder
      recorder.start(250)
      setRecording(true)
      const firstLevel = collection?.levels.find((level) => level.image && level.level === 1)
      if (firstLevel) {
        recordingSpawnTimerRef.current = window.setInterval(() => {
          if (sceneController.getObjects().length >= MAX_OBJECTS) return
          const imageSrc = URL.createObjectURL(firstLevel.image!)
          void sceneController.addDefinition(makeLevelDefinition(collection!, firstLevel, imageSrc)).then((item) => {
            if (!item) URL.revokeObjectURL(imageSrc)
            syncSceneState()
          }).catch(() => URL.revokeObjectURL(imageSrc))
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
      <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div className="brand-name">ball<span>studio</span><small>PHYSICS PLAYGROUND</small></div></div>
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

        <div className="left-panel-footer"><div className="help-dot">?</div><div><strong>BallStudio 0.1</strong><span>Создавай. Запускай. Залипай.</span></div><button className="quiet-icon" title="Справка"><span>↗</span></button></div>
      </aside>

      <section className="workspace">
        <div className="workspace-toolbar"><div className="breadcrumb"><span>Сцена</span><span className="crumb-slash">/</span><strong>Мои PNG</strong></div><div className="view-tools"><span className="scene-size"><span className="portrait-icon" /> 9:16</span><span className="toolbar-separator" /><span className="zoom-value">100%</span><button className="zoom-button" title="Масштаб по размеру экрана">⊡</button><button className="zoom-button" title="Очистить сцену" onClick={clearScene}><Icon name="close" size={15} /></button></div></div>
          <div className="canvas-workspace">
            {recordedVideoUrl && <video ref={recordedVideoRef} className="recorded-preview" src={recordedVideoUrl} controls playsInline onLoadedMetadata={(event) => setRecordedDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setRecordedCurrentTime(event.currentTarget.currentTime)} onEnded={() => setRecordedCurrentTime(recordedDuration)} />}
          <div className="stage-wrap"><div className="stage-glow" /><SimulationViewport sound={sound} collections={collections} onController={registerController} onSelectObject={registerSelection} onSceneChanged={syncSceneState} /><div className="stage-top-label"><span className="stage-live" /> LIVE PREVIEW</div><div className="stage-bottom-label"><span>360 × 640</span><span>·</span><span>9:16</span></div></div>
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
