import {
  __resetIslandProjectionForTesting,
  getIslandProjection,
  getIslandProjectionServerSnapshot,
  publishIslandProjection,
  subscribeIslandProjection,
} from "./projection-store"
import { EMPTY_ISLAND_STATE, type IslandState } from "./types"

const state = (revision: number): IslandState => ({ ...EMPTY_ISLAND_STATE, epoch: 1, revision })

beforeEach(() => {
  __resetIslandProjectionForTesting()
})

describe("island projection store", () => {
  it("starts empty", () => {
    expect(getIslandProjection()).toBeNull()
  })

  it("has no server snapshot", () => {
    publishIslandProjection(state(1))
    expect(getIslandProjectionServerSnapshot()).toBeNull()
  })

  it("publishes a projection that getIslandProjection returns by identity", () => {
    const s = state(1)
    publishIslandProjection(s)
    expect(getIslandProjection()).toBe(s)
  })

  it("notifies listeners when the projection changes", () => {
    const listener = jest.fn()
    subscribeIslandProjection(listener)
    publishIslandProjection(state(1))
    publishIslandProjection(state(2))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("does not notify when the same object is published again", () => {
    const listener = jest.fn()
    const s = state(1)
    publishIslandProjection(s)
    subscribeIslandProjection(listener)
    publishIslandProjection(s)
    expect(listener).not.toHaveBeenCalled()
  })

  it("does not notify when null is published over null", () => {
    const listener = jest.fn()
    subscribeIslandProjection(listener)
    publishIslandProjection(null)
    expect(listener).not.toHaveBeenCalled()
  })

  it("notifies when a projection is cleared to null", () => {
    const listener = jest.fn()
    publishIslandProjection(state(1))
    subscribeIslandProjection(listener)
    publishIslandProjection(null)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getIslandProjection()).toBeNull()
  })

  it("makes the new value visible to a listener that reads during notification", () => {
    const seen: Array<IslandState | null> = []
    subscribeIslandProjection(() => seen.push(getIslandProjection()))
    const s = state(7)
    publishIslandProjection(s)
    expect(seen).toEqual([s])
  })

  it("stops notifying after unsubscribe, and unsubscribe is idempotent", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeIslandProjection(listener)
    publishIslandProjection(state(1))
    unsubscribe()
    unsubscribe()
    publishIslandProjection(state(2))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("notifies every subscriber", () => {
    const a = jest.fn()
    const b = jest.fn()
    subscribeIslandProjection(a)
    subscribeIslandProjection(b)
    publishIslandProjection(state(1))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("the test reset clears both the projection and the listeners", () => {
    const listener = jest.fn()
    subscribeIslandProjection(listener)
    publishIslandProjection(state(1))
    __resetIslandProjectionForTesting()
    expect(getIslandProjection()).toBeNull()
    publishIslandProjection(state(2))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
