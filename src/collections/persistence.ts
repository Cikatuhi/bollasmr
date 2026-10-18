/**
 * Durable storage for user-authored merge collections. Binary assets are stored
 * as Blobs in IndexedDB (never as base64 strings in localStorage).
 */
import { isImageCollisionGeometry, type ImageCollisionGeometry } from '../objects/imageCollisionGeometry'

export type CollectionLevel = {
  id: string
  level: number
  name: string
  image: Blob | null
  imageName?: string
  /** Alpha-derived Matter geometry; absent on records created by older builds. */
  imageGeometry?: ImageCollisionGeometry
  size: number
  mass: number
  mergeSound: Blob | null
  mergeSoundName?: string
  mergeSoundVolume: number
}

export type UserCollection = {
  id: string
  name: string
  levels: CollectionLevel[]
  createdAt: number
  updatedAt: number
}

export interface CollectionStore {
  list(): Promise<UserCollection[]>
  get(id: string): Promise<UserCollection | undefined>
  save(collection: UserCollection): Promise<void>
  delete(id: string): Promise<void>
  close?(): void
}

const DATABASE_NAME = 'ballstudio-user-collections'
const DATABASE_VERSION = 1
const OBJECT_STORE = 'collections'
const MAX_COLLECTIONS = 100
const MAX_LEVELS = 200
const MAX_NAME_LENGTH = 120

export class CollectionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CollectionStorageError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validString(value: unknown, max = MAX_NAME_LENGTH): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validBlob(value: unknown): value is Blob | null {
  return value === null || (typeof Blob !== 'undefined' && value instanceof Blob)
}

/** Returns a normalized, validated copy or null for corrupt/incompatible records. */
export function validateCollection(value: unknown): UserCollection | null {
  if (!isRecord(value) || !validString(value.id, 200) || !validString(value.name) ||
      !Array.isArray(value.levels) || value.levels.length < 1 || value.levels.length > MAX_LEVELS ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null

  const seenLevelIds = new Set<string>()
  const seenNumbers = new Set<number>()
  const levels: CollectionLevel[] = []
  for (const candidate of value.levels) {
    if (!isRecord(candidate) || !validString(candidate.id, 200) || !validString(candidate.name) ||
        !Number.isInteger(candidate.level) || (candidate.level as number) < 1 ||
        !Number.isFinite(candidate.size) || (candidate.size as number) < 1 || (candidate.size as number) > 1000 ||
        !Number.isFinite(candidate.mass) || (candidate.mass as number) <= 0 || (candidate.mass as number) > 10000 ||
        !Number.isFinite(candidate.mergeSoundVolume) || (candidate.mergeSoundVolume as number) < 0 || (candidate.mergeSoundVolume as number) > 1 ||
        !validBlob(candidate.image) || !validBlob(candidate.mergeSound) ||
        (candidate.imageName !== undefined && !validString(candidate.imageName)) ||
        (candidate.mergeSoundName !== undefined && !validString(candidate.mergeSoundName))) return null
    const levelNumber = candidate.level as number
    if (seenLevelIds.has(candidate.id) || seenNumbers.has(levelNumber)) return null
    seenLevelIds.add(candidate.id)
    seenNumbers.add(levelNumber)
    levels.push({
      id: candidate.id,
      level: levelNumber,
      name: candidate.name.trim(),
      image: candidate.image,
      ...(candidate.imageName ? { imageName: candidate.imageName } : {}),
        ...(isImageCollisionGeometry(candidate.imageGeometry) ? { imageGeometry: candidate.imageGeometry } : {}),
      size: candidate.size as number,
      mass: candidate.mass as number,
      mergeSound: candidate.mergeSound,
      ...(candidate.mergeSoundName ? { mergeSoundName: candidate.mergeSoundName } : {}),
      mergeSoundVolume: candidate.mergeSoundVolume as number,
    })
  }
  levels.sort((a, b) => a.level - b.level)
  return {
    id: value.id,
    name: value.name.trim(),
    levels,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function storageError(message: string, cause: unknown): CollectionStorageError {
  return new CollectionStorageError(message, { cause })
}

export class IndexedDbCollectionStore implements CollectionStore {
  private dbPromise?: Promise<IDBDatabase>

  constructor(private readonly indexedDBFactory: IDBFactory = globalThis.indexedDB) {
    if (!indexedDBFactory) throw new CollectionStorageError('IndexedDB недоступна в этом браузере.')
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise
    const opening: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest
      try { request = this.indexedDBFactory.open(DATABASE_NAME, DATABASE_VERSION) }
      catch (error) { reject(storageError('Не удалось открыть хранилище коллекций.', error)); return }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(OBJECT_STORE)) db.createObjectStore(OBJECT_STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
      request.onerror = () => reject(storageError('Не удалось открыть хранилище коллекций.', request.error))
      request.onblocked = () => reject(new CollectionStorageError('Открытие хранилища заблокировано другой вкладкой.'))
    }).catch((error: unknown) => {
      this.dbPromise = undefined
      throw error
    })
    this.dbPromise = opening
    return opening
  }

  private async run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      let request: IDBRequest<T>
      let result: T
      let requestSucceeded = false
      let settled = false
      const transaction = db.transaction(OBJECT_STORE, mode)
      try { request = action(transaction.objectStore(OBJECT_STORE)) }
      catch (error) { reject(storageError('Операция с хранилищем не выполнена.', error)); return }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(storageError('Операция с хранилищем не выполнена.', error))
      }
      request.onsuccess = () => {
        result = request.result
        requestSucceeded = true
        // IDB requests can succeed before a readwrite transaction is committed;
        // wait for oncomplete so quota/abort errors are not silently swallowed.
        if (mode === 'readonly') { settled = true; resolve(result) }
      }
      request.onerror = () => fail(request.error)
      transaction.onerror = () => fail(transaction.error)
      transaction.onabort = () => fail(transaction.error ?? new Error('Transaction aborted'))
      transaction.oncomplete = () => {
        if (!settled) {
          if (requestSucceeded) { settled = true; resolve(result) }
          else fail(new Error('Transaction completed without a result'))
        }
      }
    })
  }

  async list(): Promise<UserCollection[]> {
    const records = await this.run('readonly', (store) => store.getAll())
    return (records as unknown[]).map(validateCollection).filter((item): item is UserCollection => item !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(id: string): Promise<UserCollection | undefined> {
    const record = await this.run('readonly', (store) => store.get(id))
    return validateCollection(record) ?? undefined
  }

  async save(input: UserCollection): Promise<void> {
    const collection = validateCollection(input)
    if (!collection) throw new CollectionStorageError('Коллекция содержит некорректные или неподдерживаемые данные.')
    try { await this.run('readwrite', (store) => store.put(collection)) }
    catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        throw new CollectionStorageError('Недостаточно места в браузерном хранилище. Удалите ненужные изображения или звуки.', { cause: error })
      }
      if (error instanceof CollectionStorageError && error.cause instanceof DOMException && error.cause.name === 'QuotaExceededError') {
        throw new CollectionStorageError('Недостаточно места в браузерном хранилище. Удалите ненужные изображения или звуки.', { cause: error.cause })
      }
      throw error
    }
  }

  async delete(id: string): Promise<void> {
    await this.run('readwrite', (store) => store.delete(id))
  }

  close() {
    void this.dbPromise?.then((db) => db.close())
    this.dbPromise = undefined
  }
}

/** Volatile fallback for private modes/test environments where IndexedDB is unavailable. */
export class MemoryCollectionStore implements CollectionStore {
  private readonly records = new Map<string, UserCollection>()
  async list() { return [...this.records.values()].map((value) => validateCollection(value)!).sort((a, b) => a.name.localeCompare(b.name)) }
  async get(id: string) { const value = this.records.get(id); return value ? validateCollection(value) ?? undefined : undefined }
  async save(input: UserCollection) {
    const value = validateCollection(input)
    if (!value) throw new CollectionStorageError('Коллекция содержит некорректные или неподдерживаемые данные.')
    if (!this.records.has(value.id) && this.records.size >= MAX_COLLECTIONS) throw new CollectionStorageError('Достигнут лимит в 100 коллекций.')
    this.records.set(value.id, value)
  }
  async delete(id: string) { this.records.delete(id) }
}

/** Uses durable IndexedDB when possible; fallback is explicitly volatile. */
export function createCollectionStore(): CollectionStore {
  try { return new IndexedDbCollectionStore(globalThis.indexedDB) }
  catch { return new MemoryCollectionStore() }
}
