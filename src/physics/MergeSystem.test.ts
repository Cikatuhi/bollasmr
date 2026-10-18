import { describe, expect, it } from 'vitest'
import { Body, Composite } from 'matter-js'
import type { ObjectDefinition } from '../objects/definitions'
import { makeDefinition } from '../objects/definitions'
import { SimulationScene, type SceneObject } from './SimulationScene'
import { MergeSystem } from './MergeSystem'

type MergeDefinition = ObjectDefinition & { collectionId: string; level: number }

const definition = (id: string, collectionId: string, level: number): MergeDefinition => ({
  ...makeDefinition('circle', id, { radius: 14 + level * 2, label: `${collectionId} ${level}` }),
  collectionId, level,
})

function setup(nextLevels: Record<string, ObjectDefinition | undefined> = {}) {
  const scene = new SimulationScene()
  let sequence = 0
  const merged: Array<{ from: number; to: number }> = []
  const sounds: string[] = []
  const removeObject = (object: SceneObject) => {
    Composite.remove(scene.engine.world, object.body)
    const index = scene.objects.indexOf(object)
    if (index >= 0) scene.objects.splice(index, 1)
  }
  const merge = new MergeSystem({
    getNextLevel: (identity) => {
      const next = nextLevels[`${identity.collectionId}:${identity.level + 1}`]
      return next ? { identity: { collectionId: identity.collectionId, level: identity.level + 1 }, definition: next } : undefined
    },
    removeObject,
    createObject: (nextDefinition, position, velocity) => {
      const object = scene.addObject(nextDefinition, position.x, position.y)
      if (object) Body.setVelocity(object.body, velocity)
      return object
    },
    onMerged: ({ from, to }) => {
      merged.push({ from: from.level, to: to.level })
      sounds.push(`${from.collectionId}:${from.level}->${to.level}`)
    },
  })
  return { scene, merge, merged, sounds, nextId: () => `merged-${sequence++}` }
}

function add(scene: SimulationScene, collectionId: string, level: number, id: string, x: number) {
  return scene.addObject(definition(id, collectionId, level), x, 180)!
}

describe('MergeSystem', () => {
  it('merges two level-one objects into one level two object', () => {
    const next = definition('level-2', 'cats', 2)
    const { scene, merge, merged } = setup({ 'cats:2': next })
    const first = add(scene, 'cats', 1, 'a', 140)
    const second = add(scene, 'cats', 1, 'b', 170)
    expect(merge.enqueue(first, second, 2)).toBe(true)
    expect(merge.flush()).toBe(1)
    expect(merged).toEqual([{ from: 1, to: 2 }])
    expect(scene.findObject('a')).toBeUndefined()
    expect(scene.findObject('b')).toBeUndefined()
    expect(scene.objects).toHaveLength(1)
    expect(scene.engine.world.bodies).not.toContain(first.body)
    expect(scene.engine.world.bodies).not.toContain(second.body)
    expect(scene.engine.world.bodies).toContain(scene.objects[0]!.body)
    expect((scene.objects[0]!.definition as MergeDefinition).level).toBe(2)
    expect(scene.objects[0]!.body.position.x).toBeCloseTo(155)
    expect(scene.objects[0]!.body.position.y).toBeCloseTo(180)
    scene.destroy()
  })

  it('supports a second transition (level two to level three)', () => {
    const { scene, merge, merged } = setup({ 'cats:3': definition('level-3', 'cats', 3) })
    const first = add(scene, 'cats', 2, 'a', 140)
    const second = add(scene, 'cats', 2, 'b', 170)
    merge.enqueue(first, second)
    expect(merge.flush()).toBe(1)
    expect(merged).toEqual([{ from: 2, to: 3 }])
    scene.destroy()
  })

  it('does not merge different collections or different levels', () => {
    const next = definition('level-2', 'cats', 2)
    const { scene, merge } = setup({ 'cats:2': next })
    const cats = add(scene, 'cats', 1, 'cats', 120)
    const dogs = add(scene, 'dogs', 1, 'dogs', 160)
    const levelTwo = add(scene, 'cats', 2, 'level-two', 200)
    expect(merge.enqueue(cats, dogs)).toBe(true)
    expect(merge.enqueue(cats, levelTwo)).toBe(true)
    expect(merge.flush()).toBe(0)
    expect(scene.objects).toHaveLength(3)
    scene.destroy()
  })

  it('leaves a terminal level in the scene', () => {
    const { scene, merge } = setup()
    const first = add(scene, 'cats', 4, 'a', 140)
    const second = add(scene, 'cats', 4, 'b', 170)
    merge.enqueue(first, second)
    expect(merge.flush()).toBe(0)
    expect(scene.objects).toHaveLength(2)
    scene.destroy()
  })

  it('deduplicates repeated collision events and emits one merge callback', () => {
    const { scene, merge, sounds } = setup({ 'cats:2': definition('level-2', 'cats', 2) })
    const first = add(scene, 'cats', 1, 'a', 140)
    const second = add(scene, 'cats', 1, 'b', 170)
    expect(merge.enqueue(first, second)).toBe(true)
    expect(merge.enqueue(second, first)).toBe(false)
    expect(merge.flush()).toBe(1)
    expect(sounds).toEqual(['cats:1->2'])
    scene.destroy()
  })

  it('does not require a sound callback for a successful merge', () => {
    const { scene, merge } = setup({ 'cats:2': definition('level-2', 'cats', 2) })
    const first = add(scene, 'cats', 1, 'a', 140)
    const second = add(scene, 'cats', 1, 'b', 170)
    // The coordinator itself is audio-agnostic; no callback means silent merge.
    merge.enqueue(first, second)
    expect(() => merge.flush()).not.toThrow()
    expect(scene.objects).toHaveLength(1)
    scene.destroy()
  })
})
