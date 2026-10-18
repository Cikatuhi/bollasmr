import { describe, expect, it } from 'vitest'
import Matter from 'matter-js'
import { coalesceCompoundManifolds } from './compoundManifolds'

type Collision = ReturnType<typeof Matter.Detector.collisions>[number]

describe('coalesceCompoundManifolds', () => {
  it('drops duplicate local fixture contacts but keeps distant lobes', () => {
    const compoundA = Matter.Body.create({ parts: [
      Matter.Bodies.rectangle(100, 100, 20, 20),
      Matter.Bodies.rectangle(100, 100, 12, 12),
    ] })
    const compoundB = Matter.Body.create({ parts: [
      Matter.Bodies.rectangle(200, 100, 20, 20),
      Matter.Bodies.rectangle(200, 100, 12, 12),
    ] })
    const makeCollision = (x: number, y: number, depth: number) => ({
      parentA: compoundA,
      parentB: compoundB,
      bodyA: compoundA.parts[1]!,
      bodyB: compoundB.parts[1]!,
      depth,
      supports: [{ x, y }],
    } as unknown as Collision)
    const deepestLocal = makeCollision(100, 100, 3)
    const duplicateLocal = makeCollision(102, 101, 2)
    const distantLobe = makeCollision(120, 100, 1)
    const input = [duplicateLocal, distantLobe, deepestLocal]

    const output = coalesceCompoundManifolds(input)

    expect(output).toHaveLength(2)
    expect(output).toContain(deepestLocal)
    expect(output).toContain(distantLobe)
    expect(output).not.toContain(duplicateLocal)
  })

  it('treats nearby tile-edge normals as one touch but retains a distant lobe', () => {
    const compoundA = Matter.Body.create({ parts: [
      Matter.Bodies.rectangle(100, 100, 48, 48),
      Matter.Bodies.rectangle(100, 100, 12, 12),
    ] })
    const compoundB = Matter.Body.create({ parts: [
      Matter.Bodies.rectangle(200, 100, 48, 48),
      Matter.Bodies.rectangle(200, 100, 12, 12),
    ] })
    const makeCollision = (x: number, y: number, depth: number, normal: Matter.Vector) => ({
      parentA: compoundA,
      parentB: compoundB,
      bodyA: compoundA.parts[1]!,
      bodyB: compoundB.parts[1]!,
      depth,
      normal,
      supports: [{ x, y }],
    } as unknown as Collision)
    const shallowTileEdge = makeCollision(100, 100, 1.4, { x: 0, y: -1 })
    const deeperTileEdge = makeCollision(109, 101, 2, { x: -1, y: 0 })
    const separateLobe = makeCollision(127, 100, 0.8, { x: 0, y: 1 })

    const output = coalesceCompoundManifolds([shallowTileEdge, deeperTileEdge, separateLobe])

    // The two close fixtures have incompatible axis-aligned normals, but
    // represent one visible contact near a tile seam; resolving both creates
    // the tiny competing pushes seen as plastic jitter. The distant lobe is
    // still an independent constraint and is intentionally retained.
    expect(output).toEqual([deeperTileEdge, separateLobe])
  })
})
