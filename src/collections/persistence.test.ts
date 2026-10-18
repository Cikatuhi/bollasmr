import { describe, expect, it } from 'vitest'
import {
  CollectionStorageError,
  MemoryCollectionStore,
  validateCollection,
  type UserCollection,
} from './persistence'
import { imageCollisionGeometryFromAlpha } from '../objects/imageCollisionGeometry'

function collection(overrides: Partial<UserCollection> = {}): UserCollection {
  return {
    id: 'cats',
    name: 'Котики',
    createdAt: 10,
    updatedAt: 11,
    levels: [
      { id: 'cat-2', level: 2, name: 'Котик 2', image: new Blob(['png']), imageName: 'cat2.png', size: 30, mass: 2, mergeSound: new Blob(['audio']), mergeSoundName: 'merge.mp3', mergeSoundVolume: 0.7 },
      { id: 'cat-1', level: 1, name: 'Котик 1', image: null, size: 20, mass: 1, mergeSound: null, mergeSoundVolume: 0.5 },
    ],
    ...overrides,
  }
}

describe('collection persistence model', () => {
  it('validates and normalizes records while preserving binary assets', () => {
    const input = collection()
    const result = validateCollection(input)
    expect(result?.levels.map((level) => level.level)).toEqual([1, 2])
    expect(result?.levels[1].image).toBe(input.levels[0].image)
    expect(result?.levels[1].mergeSoundName).toBe('merge.mp3')
  })

  it('persists validated alpha-derived PNG physics geometry', () => {
    const geometry = imageCollisionGeometryFromAlpha(2, 2, 2, 2, new Uint8Array([255, 0, 255, 0]))
    const input = collection({ levels: [{ ...collection().levels[0]!, imageGeometry: geometry }] })
    const result = validateCollection(input)
    expect(result?.levels[0]?.imageGeometry).toEqual(geometry)
  })

  it.each([
    ['duplicate level numbers', collection({ levels: [collection().levels[0], { ...collection().levels[1], level: 2 }] })],
    ['invalid size', collection({ levels: [{ ...collection().levels[0], size: 0 }] })],
    ['missing id', collection({ id: '' })],
    ['invalid image payload', collection({ levels: [{ ...collection().levels[0], image: 'data:image/png;base64,broken' as unknown as Blob }] })],
  ])('rejects corrupt/incompatible records (%s)', (_name, value) => {
    expect(validateCollection(value)).toBeNull()
  })

  it('saves, restores, updates, and removes collections in the volatile fallback', async () => {
    const store = new MemoryCollectionStore()
    const value = collection()
    await store.save(value)
    expect((await store.get('cats'))?.levels).toHaveLength(2)
    expect(await store.list()).toHaveLength(1)
    await store.delete('cats')
    expect(await store.get('cats')).toBeUndefined()
  })

  it('rejects invalid writes rather than persisting malformed data', async () => {
    const store = new MemoryCollectionStore()
    await expect(store.save(collection({ levels: [] }))).rejects.toBeInstanceOf(CollectionStorageError)
  })
})
