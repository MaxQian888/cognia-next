import {
  getActiveCogsetFollower,
  getActiveCogsetWriteThrough,
  setActiveCogsetFollower,
  setActiveCogsetWriteThrough,
} from "./follower-registry"

describe("follower registry", () => {
  it("holds the running follower until it is cleared", () => {
    expect(getActiveCogsetFollower()).toBeNull()
    const follower = { evaluate: jest.fn(async () => undefined) }
    setActiveCogsetFollower(follower)
    expect(getActiveCogsetFollower()).toBe(follower)
    setActiveCogsetFollower(null)
    expect(getActiveCogsetFollower()).toBeNull()
  })

  it("holds the running write-through until it is cleared", () => {
    expect(getActiveCogsetWriteThrough()).toBeNull()
    const writeThrough = { settled: jest.fn(async () => undefined) }
    setActiveCogsetWriteThrough(writeThrough)
    expect(getActiveCogsetWriteThrough()).toBe(writeThrough)
    setActiveCogsetWriteThrough(null)
    expect(getActiveCogsetWriteThrough()).toBeNull()
  })
})
