import type { ItemOwner } from "@/types/placement/item-owner"

import type { AuthorityDecision } from "./authority"
import {
  assertRunsHere,
  isItemOwnedElsewhereError,
  isOwnedElsewhere,
  isPinnedHere,
  ItemOwnedElsewhereError,
  parseItemOwner,
  pinnedHere,
  resolveItemTimingAuthority,
  runsHere,
} from "./ownership"

const moved: ItemOwner = {
  kind: "remote-host",
  hostId: "h1",
  hostLabel: "Mac mini",
  remoteItemId: "task-1",
  operationId: "op-1",
  movedAt: 1,
}

const standDown: AuthorityDecision = {
  isAuthority: false,
  degraded: false,
  authorityHostId: "h1",
}

describe("runsHere", () => {
  it("runs unpinned and pinned items here, and never a placeholder", () => {
    expect(runsHere(undefined)).toBe(true)
    expect(runsHere(pinnedHere("manual", 5))).toBe(true)
    expect(runsHere(moved)).toBe(false)
    expect(isOwnedElsewhere(moved)).toBe(true)
    expect(isPinnedHere(pinnedHere("machine-bound", 5))).toBe(true)
  })
})

describe("resolveItemTimingAuthority", () => {
  it("defers an unpinned item to the global authority, exactly as before", () => {
    const global = jest.fn(() => standDown)
    expect(resolveItemTimingAuthority(undefined, global)).toEqual({
      ...standDown,
      ownedElsewhere: false,
    })
    expect(global).toHaveBeenCalledTimes(1)
  })

  it("fires an item pinned here even when another host holds the global authority", () => {
    const global = jest.fn(() => standDown)
    expect(resolveItemTimingAuthority(pinnedHere("machine-bound", 1), global)).toMatchObject({
      isAuthority: true,
      ownedElsewhere: false,
    })
    expect(global).not.toHaveBeenCalled()
  })

  it("never fires a placeholder, even on the global authority", () => {
    const global = jest.fn((): AuthorityDecision => ({
      isAuthority: true,
      degraded: false,
      authorityHostId: null,
    }))
    expect(resolveItemTimingAuthority(moved, global)).toEqual({
      isAuthority: false,
      degraded: false,
      authorityHostId: "h1",
      ownedElsewhere: true,
    })
    expect(global).not.toHaveBeenCalled()
  })
})

describe("assertRunsHere", () => {
  it("refuses a write that would run a placeholder here, naming the host", () => {
    expect(() => assertRunsHere("scheduled-task", undefined)).not.toThrow()
    let caught: unknown
    try {
      assertRunsHere("bot-installation", moved)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ItemOwnedElsewhereError)
    expect((caught as ItemOwnedElsewhereError).hostLabel).toBe("Mac mini")
    expect((caught as Error).message).toMatch(
      /^item_owned_elsewhere: this bot installation runs on Mac mini/
    )
    expect(isItemOwnedElsewhereError(caught)).toBe(true)
    // Across a wire the class is gone; the message prefix still identifies it.
    expect(isItemOwnedElsewhereError(new Error((caught as Error).message))).toBe(true)
    expect(isItemOwnedElsewhereError(new Error("other"))).toBe(false)
  })
})

describe("parseItemOwner", () => {
  it("round-trips both kinds", () => {
    expect(parseItemOwner(JSON.parse(JSON.stringify(moved)))).toEqual(moved)
    const pin = pinnedHere("manual", 9)
    expect(parseItemOwner(pin)).toEqual(pin)
  })

  it("drops a malformed owner instead of stranding the item", () => {
    expect(parseItemOwner(null)).toBeUndefined()
    expect(parseItemOwner({ kind: "remote-host", hostId: "h1" })).toBeUndefined()
    expect(parseItemOwner({ ...moved, movedAt: -1 })).toBeUndefined()
    expect(parseItemOwner({ kind: "this-device", reason: "whim", pinnedAt: 1 })).toBeUndefined()
    expect(parseItemOwner({ kind: "elsewhere" })).toBeUndefined()
  })

  it("keeps only the declared fields", () => {
    expect(parseItemOwner({ ...moved, extra: "x" })).toEqual(moved)
  })
})
