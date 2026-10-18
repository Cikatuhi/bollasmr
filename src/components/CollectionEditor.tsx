import { useEffect, useState, type ChangeEvent } from 'react'
import type { CollectionLevel, UserCollection } from '../collections/persistence'
import { ARENA_MAX_ENTRY_DIAMETER } from '../arena/geometry'

type Props = {
  collections: UserCollection[]
  selectedId?: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onAddLevel: (id: string) => void
  onDeleteLevel: (id: string, levelId: string) => void
  onUpdateLevel: (id: string, levelId: string, patch: Partial<CollectionLevel>) => void
  onImage: (id: string, levelId: string, file: File) => void
  onRemoveImage: (id: string, levelId: string) => void
  onSound: (id: string, levelId: string, file: File) => void
  onRemoveSound: (id: string, levelId: string) => void
  onTestSound: (id: string, level: number) => void
  onAddToScene: (collection: UserCollection, level: CollectionLevel) => void | Promise<void>
}

const levelStatus = (level: CollectionLevel) => level.image ? 'PNG готов' : 'PNG не загружен'

function LevelThumb({ image }: { image: Blob | null }) {
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    if (!image) { setSrc(undefined); return }
    const next = URL.createObjectURL(image)
    setSrc(next)
    return () => URL.revokeObjectURL(next)
  }, [image])
  return <div className={`level-thumb ${failed ? 'failed' : ''}`}>{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <span>{failed ? 'Ошибка' : 'PNG'}</span>}</div>
}

export default function CollectionEditor({
  collections, selectedId, onSelect, onCreate, onDelete, onRename, onAddLevel, onDeleteLevel,
  onUpdateLevel, onImage, onRemoveImage, onSound, onRemoveSound, onTestSound, onAddToScene,
}: Props) {
  const collection = collections.find((item) => item.id === selectedId) ?? collections[0]
  const imageChange = (level: CollectionLevel, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onImage(collection.id, level.id, file)
  }
  const soundChange = (level: CollectionLevel, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onSound(collection.id, level.id, file)
  }

  return <section className="collection-editor inspector-section">
    <div className="inspector-title collection-title"><span className="title-icon selected-icon">✦</span><div><h2>Коллекции объектов</h2><p>Загружай PNG — после загрузки они падают в арену</p></div><button className="quiet-icon" onClick={onCreate} title="Создать коллекцию">＋</button></div>
    {!collection ? <div className="collection-empty"><p>Создай коллекцию, чтобы настроить уровни и добавить их в сцену.</p><button className="text-button" onClick={onCreate}>Создать коллекцию</button></div> : <>
      <div className="collection-toolbar"><select value={collection.id} onChange={(event) => onSelect(event.target.value)} aria-label="Коллекция">{collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="quiet-icon danger" onClick={() => onDelete(collection.id)} title="Удалить коллекцию">×</button></div>
      <input className="collection-name-input" value={collection.name} maxLength={120} onChange={(event) => onRename(collection.id, event.target.value)} aria-label="Название коллекции" />
      <div className="collection-levels">{[...collection.levels].sort((a, b) => a.level - b.level).map((level) => <article className="collection-level" key={level.id}>
        <div className="level-heading"><span className="level-badge">L{level.level}</span><input value={level.name} onChange={(event) => onUpdateLevel(collection.id, level.id, { name: event.target.value })} aria-label={`Название уровня ${level.level}`} /><span className={`level-status ${level.image ? 'ready' : ''}`}>{levelStatus(level)}</span></div>
        <div className="level-main">
          <LevelThumb image={level.image} />
          <div className="level-fields"><label>Размер<input type="number" min="8" max={ARENA_MAX_ENTRY_DIAMETER} value={level.size} onChange={(event) => onUpdateLevel(collection.id, level.id, { size: Math.min(ARENA_MAX_ENTRY_DIAMETER, Math.max(8, Number(event.target.value) || 8)) })} /></label><label>Масса<input type="number" min="0.1" max="10000" step="0.1" value={level.mass} onChange={(event) => onUpdateLevel(collection.id, level.id, { mass: Number(event.target.value) || 0.1 })} /></label></div>
        </div>
        {level.size > ARENA_MAX_ENTRY_DIAMETER && <p className="level-fit-warning">Размер больше входа арены. Уменьшите до {ARENA_MAX_ENTRY_DIAMETER}, чтобы объект мог пройти в чашу.</p>}
        <div className="level-actions"><label className="mini-upload"><input type="file" accept="image/png" onChange={(event) => imageChange(level, event)} />{level.image ? 'Заменить PNG' : 'Загрузить PNG'}</label>{level.image && <button className="mini-button danger" onClick={() => onRemoveImage(collection.id, level.id)}>Удалить PNG</button>}<button className="mini-button" disabled={!level.image} onClick={() => onAddToScene(collection, level)} title="Добавить ещё одну копию для слияния">＋ Ещё объект</button><button className="mini-button danger" onClick={() => onDeleteLevel(collection.id, level.id)} disabled={collection.levels.length <= 1 || level.level !== Math.max(...collection.levels.map((item) => item.level))}>Удалить уровень</button></div>
        <div className="level-sound"><span>Переход L{level.level} → L{level.level + 1}</span><label className="mini-upload sound-upload"><input type="file" accept="audio/*" onChange={(event) => soundChange(level, event)} />{level.mergeSound ? 'Заменить звук' : 'Загрузить звук'}</label>{level.mergeSoundName && <button className="sound-file" onClick={() => onTestSound(collection.id, level.level)}>▶ {level.mergeSoundName}</button>}{level.mergeSound && <button className="quiet-icon danger" onClick={() => onRemoveSound(collection.id, level.id)} title="Удалить звук">×</button>}<input className="sound-volume" type="range" min="0" max="1" step="0.01" value={level.mergeSoundVolume} onChange={(event) => onUpdateLevel(collection.id, level.id, { mergeSoundVolume: Number(event.target.value) })} aria-label="Громкость перехода" /></div>
      </article>)}</div>
      <button className="add-level-button" onClick={() => onAddLevel(collection.id)}>＋ Добавить уровень</button>
    </>}
  </section>
}
