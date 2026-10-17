import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, ReactNode } from 'react'
import { AudioEngine, type CollisionSoundKind } from './audio/AudioEngine'
import SimulationViewport, { type SceneController } from './components/SimulationViewport'
import CollectionEditor from './components/CollectionEditor'
import { createCollectionStore, type CollectionLevel, type CollectionStore, type UserCollection } from './collections/persistence'
import type { ObjectDefinition, ObjectKind } from './objects/definitions'
import { MAX_BALLS } from './physics/SimulationScene'

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
  const [restitution, setRestitution] = useState(0.82)
  const [speed, setSpeed] = useState(1)
  const [ballCount, setBallCount] = useState(24)
  const [volume, setVolume] = useState(0.32)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [soundKind, setSoundKind] = useState<CollisionSoundKind>('circle')
  const [selected, setSelected] = useState<ObjectDefinition | null>(null)
  const [objectCount, setObjectCount] = useState(25)
  const [layerItems, setLayerItems] = useState<ObjectDefinition[]>([])
  const [inspectorTab, setInspectorTab] = useState<'settings' | 'layers'>('settings')
  const [collections, setCollections] = useState<UserCollection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>()
  const collectionStoreRef = useRef<CollectionStore | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  useEffect(() => {
    const store = createCollectionStore()
    collectionStoreRef.current = store
    void store.list().then((items) => {
      setCollections(items)
      setSelectedCollectionId(items[0]?.id)
      for (const collection of items) for (const level of collection.levels) {
        if (level.mergeSound) void sound.loadMergeSound(collection.id, level.level, level.mergeSound, level.mergeSoundVolume).catch(() => undefined)
      }
    }).catch((error) => { console.error('Не удалось загрузить коллекции:', error); window.alert('Не удалось загрузить локальные коллекции.') })
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
  useEffect(() => () => {
    sound.dispose()
  }, [sound])
  const applySettings = (next: Partial<{ gravity: number; restitution: number; speed: number }>) => controller?.setSettings(next)

  const updateBallCount = (value: number) => {
    setBallCount(value)
    controller?.reset(value)
    setSelected(null)
    setObjectCount(value + 1)
    setLayerItems(controller?.getObjects().map((item) => ({ ...item.definition })) ?? [])
  }

  const addObject = (kind: ObjectKind, overrides: Partial<ObjectDefinition> = {}) => {
    const item = controller?.addObject(kind, overrides)
    if (item) {
      setSelected({ ...item.definition })
      setObjectCount((count) => Math.min(count + 1, 150))
      setLayerItems(controller?.getObjects().map((entry) => ({ ...entry.definition })) ?? [])
    }
    return item
  }

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

  const resetScene = () => {
    controller?.reset(ballCount)
    setSelected(null)
    setObjectCount(ballCount + 1)
    setLayerItems(controller?.getObjects().map((item) => ({ ...item.definition })) ?? [])
  }

  const clearScene = () => {
    controller?.removeAll()
    setSelected(null)
    setObjectCount(0)
    setLayerItems([])
  }

  const handleImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !file.type.startsWith('image/')) return
    const src = URL.createObjectURL(file)
    const item = addObject('image', { imageSrc: src, label: file.name.slice(0, 28), color: 0xffffff, radius: 28 })
    if (!item) URL.revokeObjectURL(src)
  }

  const handleAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try { await sound.loadUserAudio(file, soundKind) }
    catch (error) { console.error('Не удалось загрузить аудио:', error); window.alert('Не удалось прочитать этот аудиофайл.') }
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
    const collection: UserCollection = { id: makeId(), name: `Коллекция ${collections.length + 1}`, createdAt: now, updatedAt: now, levels: [{ id: makeId(), level: 1, name: 'Уровень 1', image: null, size: 48, mass: 1, mergeSound: null, mergeSoundVolume: 1 }] }
    setCollections((items) => [...items, collection])
    setSelectedCollectionId(collection.id)
    void collectionStoreRef.current?.save(collection).catch((error) => window.alert(error instanceof Error ? error.message : 'Не удалось сохранить коллекцию.'))
  }
  const deleteCollection = (id: string) => {
    const next = collections.filter((item) => item.id !== id)
    setCollections(next)
    setSelectedCollectionId((selected) => selected === id ? next[0]?.id : selected)
    void collectionStoreRef.current?.delete(id).catch((error) => console.error(error))
  }
  const addLevel = (id: string) => commitCollection(id, (collection) => {
    const level = Math.max(0, ...collection.levels.map((item) => item.level)) + 1
    return { ...collection, levels: [...collection.levels, { id: makeId(), level, name: `Уровень ${level}`, image: null, size: 48, mass: 1, mergeSound: null, mergeSoundVolume: 1 }] }
  })
  const deleteLevel = (id: string, levelId: string) => commitCollection(id, (collection) => collection.levels.length <= 1 ? collection : ({ ...collection, levels: collection.levels.filter((item) => item.id !== levelId) }))
  const updateLevel = (id: string, levelId: string, patch: Partial<CollectionLevel>) => {
    const level = collections.find((item) => item.id === id)?.levels.find((item) => item.id === levelId)
    if (level && patch.mergeSoundVolume !== undefined) sound.setMergeSoundVolume(id, level.level, patch.mergeSoundVolume)
    commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((item) => item.id === levelId ? { ...item, ...patch } : item) }))
  }
  const uploadCollectionImage = (id: string, levelId: string, file: File) => {
    if (file.type !== 'image/png') { window.alert('Для уровня нужен PNG с прозрачным фоном.'); return }
    if (file.size > 12 * 1024 * 1024) { window.alert('PNG слишком большой (максимум 12 МБ).'); return }
    commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((level) => level.id === levelId ? { ...level, image: file, imageName: file.name } : level) }))
  }
  const removeCollectionImage = (id: string, levelId: string) => commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((level) => level.id === levelId ? { ...level, image: null, imageName: undefined } : level) }))
  const uploadCollectionSound = (id: string, levelId: string, file: File) => {
    if (!file.type.startsWith('audio/')) { window.alert('Выберите аудиофайл.'); return }
    if (file.size > 20 * 1024 * 1024) { window.alert('Аудиофайл слишком большой (максимум 20 МБ).'); return }
    const collection = collections.find((item) => item.id === id)
    const level = collection?.levels.find((item) => item.id === levelId)
    if (!collection || !level) return
    void sound.loadMergeSound(id, level.level, file, level.mergeSoundVolume).then(() => {
      commitCollection(id, (current) => ({ ...current, levels: current.levels.map((item) => item.id === levelId ? { ...item, mergeSound: file, mergeSoundName: file.name } : item) }))
    }).catch(() => window.alert('Не удалось прочитать аудиофайл.'))
  }
  const removeCollectionSound = (id: string, levelId: string) => {
    const level = collections.find((item) => item.id === id)?.levels.find((item) => item.id === levelId)
    if (!level) return
    sound.removeMergeSound(id, level.level)
    commitCollection(id, (collection) => ({ ...collection, levels: collection.levels.map((item) => item.id === levelId ? { ...item, mergeSound: null, mergeSoundName: undefined } : item) }))
  }
  const addCollectionLevelToScene = (collection: UserCollection, level: CollectionLevel) => {
    if (!level.image) return
    const imageSrc = URL.createObjectURL(level.image)
    const item = controller?.addDefinition({ id: `user-${makeId()}`, kind: 'image', visual: 'image', label: level.name, color: 0xffffff, radius: level.size / 2, mass: level.mass, restitution, imageSrc, collectionId: collection.id, level: level.level })
    if (!item) URL.revokeObjectURL(imageSrc)
    syncSceneState()
  }

  return <main className="editor-app">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div className="brand-name">ball<span>studio</span><small>PHYSICS PLAYGROUND</small></div></div>
      <div className="topbar-divider" />
      <div className="document-title"><span className="live-dot" /><span>Отскок · демо-сцена</span><span className="save-pill">Локально</span></div>
      <div className="topbar-actions">
        <div className="transport-group">
          <button className={`transport-button primary ${running ? '' : 'is-paused'}`} onClick={toggleRunning} disabled={!controller} aria-label={running ? 'Пауза' : 'Запуск'}><Icon name={running ? 'pause' : 'play'} size={17} /><span>{running ? 'Пауза' : 'Запуск'}</span></button>
          <button className="icon-button" onClick={resetScene} disabled={!controller} title="Перезапустить сцену" aria-label="Перезапустить"><Icon name="reset" /></button>
        </div>
        <div className="topbar-divider small" />
        <button className="export-button" disabled title="Экспорт видео появится в будущей версии">Экспорт <span>↗</span></button>
        <div className="avatar">B</div>
      </div>
    </header>

    <div className="editor-layout">
      <aside className="left-panel panel">
        <div className="panel-heading"><span>ПРОЕКТ</span><button className="quiet-icon" title="Новый проект" onClick={resetScene}><Icon name="plus" size={15} /></button></div>
        <div className="project-card"><div className="project-thumb"><span className="thumb-orbit" /><span className="thumb-ball pink" /><span className="thumb-ball violet" /><span className="thumb-ball mint" /></div><div><strong>Прыгающие шары</strong><span>Демо-сцена · 9:16</span></div><span className="more-dots">···</span></div>

        <div className="section-label">РЕЖИМЫ</div>
        <nav className="mode-list" aria-label="Режимы симуляции">
          <button className="mode-item active"><span className="mode-icon active-mode"><Icon name="ball" /></span><span><strong>Отскок</strong><small>Физика шаров</small></span><span className="mode-arrow">⌄</span></button>
          <button className="mode-item planned" title="Скоро"><span className="mode-icon"><Icon name="layers" /></span><span><strong>Спираль</strong><small>В разработке</small></span><span className="soon-tag">Скоро</span></button>
          <button className="mode-item planned" title="Скоро"><span className="mode-icon"><Icon name="polygon" /></span><span><strong>Лабиринт</strong><small>В разработке</small></span><span className="soon-tag">Скоро</span></button>
        </nav>

        <div className="section-label object-section-heading"><span>ОБЪЕКТЫ</span><span className="count-badge">{objectCount}</span></div>
        <div className="object-tools">
          <button className="object-tool" onClick={() => addObject('circle')}><span className="tool-icon ball-tool"><Icon name="ball" /></span><span><strong>Шар</strong><small>Круглый объект</small></span><span className="tool-plus"><Icon name="plus" size={15} /></span></button>
          <button className="object-tool" onClick={() => addObject('polygon')}><span className="tool-icon polygon-tool"><Icon name="polygon" /></span><span><strong>Многоугольник</strong><small>Фигура с оболочкой</small></span><span className="tool-plus"><Icon name="plus" size={15} /></span></button>
          <button className="object-tool" onClick={() => addObject('box', { label: 'Статичная платформа', isStatic: true, width: 104, height: 12 })}><span className="tool-icon platform-tool"><Icon name="platform" /></span><span><strong>Препятствие</strong><small>Статичная платформа</small></span><span className="tool-plus"><Icon name="plus" size={15} /></span></button>
          <button className="object-tool" onClick={() => uploadRef.current?.click()}><span className="tool-icon image-tool"><Icon name="image" /></span><span><strong>Изображение</strong><small>Своя физическая форма</small></span><span className="tool-plus"><Icon name="plus" size={15} /></span></button>
          <input ref={uploadRef} className="visually-hidden" type="file" accept="image/*" onChange={handleImage} />
        </div>

        <div className="left-panel-footer"><div className="help-dot">?</div><div><strong>BallStudio 0.1</strong><span>Создавай. Запускай. Залипай.</span></div><button className="quiet-icon" title="Справка"><span>↗</span></button></div>
      </aside>

      <section className="workspace">
        <div className="workspace-toolbar"><div className="breadcrumb"><span>Сцена</span><span className="crumb-slash">/</span><strong>Отскок</strong></div><div className="view-tools"><span className="scene-size"><span className="portrait-icon" /> 9:16</span><span className="toolbar-separator" /><span className="zoom-value">100%</span><button className="zoom-button" title="Масштаб по размеру экрана">⊡</button><button className="zoom-button" title="Очистить сцену" onClick={clearScene}><Icon name="close" size={15} /></button></div></div>
        <div className="canvas-workspace">
          <div className="stage-wrap"><div className="stage-glow" /><SimulationViewport sound={sound} collections={collections} onController={registerController} onSelectObject={registerSelection} onSceneChanged={syncSceneState} /><div className="stage-top-label"><span className="stage-live" /> LIVE PREVIEW</div><div className="stage-bottom-label"><span>360 × 640</span><span>·</span><span>9:16</span></div></div>
          <div className="canvas-caption"><span className="caption-icon"><Icon name="sparkle" size={15} /></span><span>Добавляй объекты слева <i>·</i> перетаскивай их внутри сцены</span></div>
        </div>
        <div className="timeline-bar"><button className={`timeline-play ${running ? '' : 'paused'}`} onClick={toggleRunning} aria-label={running ? 'Пауза' : 'Запуск'}><Icon name={running ? 'pause' : 'play'} size={13} /></button><div className="timeline-track"><div className="timeline-fill" /><div className="timeline-scrubber" /></div><span className="timeline-time">00:08 <span>/</span> ∞</span><span className="timeline-label">СИМУЛЯЦИЯ В РЕАЛЬНОМ ВРЕМЕНИ</span></div>
      </section>

      <aside className="right-panel panel">
        <div className="inspector-tabs"><button className={`inspector-tab ${inspectorTab === 'settings' ? 'active' : ''}`} onClick={() => setInspectorTab('settings')}>Настройки</button><button className={`inspector-tab ${inspectorTab === 'layers' ? 'active' : ''}`} onClick={() => setInspectorTab('layers')}>Слои <span className="count-badge small-count">{objectCount}</span></button><button className="inspector-menu" onClick={resetScene}>···</button></div>
        {inspectorTab === 'layers' ? <div className="layer-list">{layerItems.length ? [...layerItems].reverse().map((item) => <button key={item.id} className={`layer-item ${selected?.id === item.id ? 'chosen' : ''}`} onClick={() => { setSelected(item); controller?.setSelected(item.id); setInspectorTab('settings') }}><span className="layer-color" style={{ backgroundColor: `#${item.color.toString(16).padStart(6, '0')}` }} /><span className="layer-name">{item.label}</span><span className="layer-kind">{item.kind === 'circle' ? 'КРУГ' : item.kind === 'polygon' ? 'ФИГУРА' : item.kind === 'image' ? 'IMG' : item.motion ? 'ДВИЖ.' : 'СТАТ.'}</span></button>) : <div className="empty-selection">Сцена пуста. Добавь объекты из панели слева.</div>}</div> : <div className="inspector-scroll">
          <CollectionEditor collections={collections} selectedId={selectedCollectionId} onSelect={setSelectedCollectionId} onCreate={createCollection} onDelete={deleteCollection} onRename={(id, name) => commitCollection(id, (collection) => ({ ...collection, name: name || 'Без названия' }))} onAddLevel={addLevel} onDeleteLevel={deleteLevel} onUpdateLevel={updateLevel} onImage={uploadCollectionImage} onRemoveImage={removeCollectionImage} onSound={uploadCollectionSound} onRemoveSound={removeCollectionSound} onTestSound={(id, level) => void sound.testMergeSound(id, level)} onAddToScene={addCollectionLevelToScene} />
          <section className="inspector-section"><div className="inspector-title"><span className="title-icon physics-icon"><Icon name="sparkle" size={15} /></span><div><h2>Физика сцены</h2><p>Общие параметры симуляции</p></div><button className="reset-tiny" title="Сбросить параметры" onClick={() => { setGravity(1); setRestitution(0.82); setSpeed(1); applySettings({ gravity: 1, restitution: 0.82, speed: 1 }) }}><Icon name="reset" size={14} /></button></div>
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
            </> : <div className="empty-selection">Добавь объект слева или выбери новый, чтобы настроить его размер, массу и цвет.</div>}
          </section>

          <section className="inspector-section balls-section"><div className="inspector-title"><span className="title-icon group-icon"><Icon name="layers" size={15} /></span><div><h2>Количество шаров</h2><p>Демо-сцена · ограничено до {MAX_BALLS}</p></div></div><RangeControl label="Шары в сцене" value={ballCount} min={1} max={MAX_BALLS} step={1} onChange={updateBallCount} /><div className="ball-count-note"><span className="status-dot" />{ballCount} динамических объектов <span>+ 1 платформа</span></div></section>

          <section className="inspector-section sound-section"><div className="inspector-title"><span className="title-icon audio-icon"><Icon name="sound" size={15} /></span><div><h2>Звук столкновений</h2><p>Синтезированные тоны · Web Audio</p></div><button className={`toggle ${soundEnabled ? 'on' : ''}`} onClick={() => changeSoundEnabled(!soundEnabled)} role="switch" aria-checked={soundEnabled} aria-label="Включить звук"><span /></button></div>
            <RangeControl label="Громкость" value={volume} min={0} max={1} step={0.01} onChange={changeVolume} />
            <div className="sound-actions"><label className="sound-type"><span>Тип объекта</span><select value={soundKind} onChange={(event) => setSoundKind(event.target.value as CollisionSoundKind)}><option value="circle">Шар</option><option value="polygon">Многоугольник</option><option value="image">Изображение</option><option value="box">Препятствие</option></select></label><button className="test-sound" onClick={() => void sound.test(soundKind)}><Icon name="sound" size={14} /> Проверить</button></div>
            <label className="upload-audio"><input type="file" accept="audio/*" onChange={handleAudio} /><span>＋</span> Загрузить звук для типа</label>
            <div className="audio-note"><span>♪</span> Разные формы звучат по-разному. Свой файл заменит тон выбранного типа.</div>
          </section>
        </div>}
      </aside>
    </div>
  </main>
}
