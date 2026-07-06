import { createBoundedBuffer } from "./bounded-buffer"

describe("createBoundedBuffer", () => {
  it("rejects a non-positive or non-integer capacity", () => {
    expect(() => createBoundedBuffer(0)).toThrow(/positive integer/)
    expect(() => createBoundedBuffer(-3)).toThrow(/positive integer/)
    expect(() => createBoundedBuffer(2.5)).toThrow(/positive integer/)
  })

  it("retains items in insertion order under capacity", () => {
    const buf = createBoundedBuffer<number>(5)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.toArray()).toEqual([1, 2, 3])
    expect(buf.size).toBe(3)
  })

  it("evicts the oldest items once over capacity (FIFO)", () => {
    const buf = createBoundedBuffer<number>(3)
    for (const n of [1, 2, 3, 4, 5]) buf.push(n)
    expect(buf.toArray()).toEqual([3, 4, 5])
    expect(buf.size).toBe(3)
  })

  it("toArray returns a copy — mutating it does not affect the buffer", () => {
    const buf = createBoundedBuffer<number>(3)
    buf.push(1)
    const snapshot = buf.toArray()
    snapshot.push(99)
    expect(buf.toArray()).toEqual([1])
  })

  it("clear empties the buffer", () => {
    const buf = createBoundedBuffer<string>(3)
    buf.push("a")
    buf.push("b")
    buf.clear()
    expect(buf.size).toBe(0)
    expect(buf.toArray()).toEqual([])
  })

  it("keeps exactly the most recent `capacity` items across many pushes", () => {
    const buf = createBoundedBuffer<number>(2)
    for (let i = 0; i < 100; i++) buf.push(i)
    expect(buf.toArray()).toEqual([98, 99])
  })
})
