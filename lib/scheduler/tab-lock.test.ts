/**
 * @jest-environment jsdom
 *
 * Tests for scheduler/tab-lock — leader election with Web Locks API
 * preferred and a heartbeat-based localStorage fallback.
 */

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { app: stub, scheduler: stub, store: stub, plugin: stub } }
})

import {
  startLeaderElection,
  stopLeaderElection,
  onLeaderChange,
  isLeaderTab,
  getTabId,
} from "./tab-lock"

class MockBroadcastChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null
  static instances: MockBroadcastChannel[] = []
  static throwOnConstruct = false
  postedMessages: unknown[] = []
  closed = false
  constructor(public name: string) {
    if (MockBroadcastChannel.throwOnConstruct) {
      throw new Error("not allowed")
    }
    MockBroadcastChannel.instances.push(this)
  }
  postMessage(message: unknown): void {
    this.postedMessages.push(message)
  }
  close(): void {
    this.closed = true
  }
}

beforeEach(() => {
  // Detach previous Web Locks/BroadcastChannel/heartbeat state.
  stopLeaderElection()
  MockBroadcastChannel.instances = []
  MockBroadcastChannel.throwOnConstruct = false
  ;(globalThis as unknown as { BroadcastChannel?: unknown }).BroadcastChannel = MockBroadcastChannel
  // Make sure localStorage is clean.
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
  // Default: no Web Locks support.
  delete (navigator as unknown as { locks?: unknown }).locks
})

afterEach(() => {
  stopLeaderElection()
})

describe("getTabId", () => {
  it("returns a stable, prefixed string", () => {
    const id = getTabId()
    expect(id).toMatch(/^tab-/)
    expect(getTabId()).toBe(id)
  })
})

describe("Web Locks election path", () => {
  it("claims leadership and broadcasts via BroadcastChannel", async () => {
    const requestMock = jest.fn().mockImplementation(async (_name, _opts, cb) => {
      // Acquire the lock, run the holder, then release.
      await cb()
    })
    Object.defineProperty(navigator, "locks", {
      value: { request: requestMock },
      configurable: true,
    })

    let leaderState: boolean | null = null
    const dispose = onLeaderChange((isLeader) => {
      leaderState = isLeader
    })

    await startLeaderElection()
    // Drain microtasks so request() callback runs and lock is held until
    // stopLeaderElection() aborts.
    await new Promise((r) => setTimeout(r, 0))
    expect(isLeaderTab()).toBe(true)
    expect(leaderState).toBe(true)
    expect(MockBroadcastChannel.instances[0].postedMessages[0]).toMatchObject({
      type: "leader-claimed",
    })

    dispose()
  })

  it("falls back to heartbeat when Web Locks errors with a non-AbortError", async () => {
    const requestMock = jest.fn().mockRejectedValue(new Error("locks broken"))
    Object.defineProperty(navigator, "locks", {
      value: { request: requestMock },
      configurable: true,
    })

    await startLeaderElection()
    // Heartbeat path should claim leader for this lone tab.
    expect(isLeaderTab()).toBe(true)
  })

  it("ignores AbortError from Web Locks (treated as planned cancellation)", async () => {
    const abortError = new DOMException("aborted", "AbortError")
    const requestMock = jest.fn().mockRejectedValue(abortError)
    Object.defineProperty(navigator, "locks", {
      value: { request: requestMock },
      configurable: true,
    })

    await startLeaderElection()
    // No fallback should engage — leader still false (lock never acquired).
    expect(isLeaderTab()).toBe(false)
  })

  it("captures the abort flow when stopLeaderElection runs", async () => {
    const requestMock = jest.fn().mockImplementation(async (_name, _opts, cb) => cb())
    Object.defineProperty(navigator, "locks", {
      value: { request: requestMock },
      configurable: true,
    })

    await startLeaderElection()
    await new Promise((r) => setTimeout(r, 0))
    stopLeaderElection()
    expect(isLeaderTab()).toBe(false)
  })
})

describe("Heartbeat election fallback", () => {
  beforeEach(() => {
    // Force fallback path by removing locks entirely (`'locks' in navigator`
    // must be false).
    delete (navigator as unknown as { locks?: unknown }).locks
  })

  it("claims leadership when no heartbeat exists", async () => {
    await startLeaderElection()
    expect(isLeaderTab()).toBe(true)
    const raw = localStorage.getItem("cognia-scheduler-leader-heartbeat")
    expect(raw).toBeTruthy()
  })

  it("refreshes its own heartbeat on subsequent claims", async () => {
    jest.useFakeTimers()
    try {
      await startLeaderElection()
      const initial = localStorage.getItem("cognia-scheduler-leader-heartbeat")
      jest.advanceTimersByTime(2000)
      const refreshed = localStorage.getItem("cognia-scheduler-leader-heartbeat")
      // Same tabId, possibly different timestamp.
      const initialData = JSON.parse(initial!) as { tabId: string }
      const refreshedData = JSON.parse(refreshed!) as { tabId: string }
      expect(initialData.tabId).toBe(refreshedData.tabId)
    } finally {
      jest.useRealTimers()
    }
  })

  it("stays follower when another tab posted a recent heartbeat", async () => {
    localStorage.setItem(
      "cognia-scheduler-leader-heartbeat",
      JSON.stringify({ tabId: "other", timestamp: Date.now() })
    )
    await startLeaderElection()
    expect(isLeaderTab()).toBe(false)
  })

  it("claims leadership when the existing heartbeat is stale", async () => {
    localStorage.setItem(
      "cognia-scheduler-leader-heartbeat",
      JSON.stringify({ tabId: "other", timestamp: Date.now() - 60000 })
    )
    await startLeaderElection()
    expect(isLeaderTab()).toBe(true)
  })

  it("falls back to leader when localStorage throws", async () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = jest.fn(() => {
      throw new Error("storage forbidden")
    })
    try {
      await startLeaderElection()
      expect(isLeaderTab()).toBe(true)
    } finally {
      Storage.prototype.getItem = original
    }
  })

  it("storage event from another tab surrenders leadership", async () => {
    await startLeaderElection()
    expect(isLeaderTab()).toBe(true)

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "cognia-scheduler-leader-heartbeat",
        newValue: JSON.stringify({ tabId: "someone-else", timestamp: Date.now() }),
      })
    )
    expect(isLeaderTab()).toBe(false)
  })

  it("storage event with malformed JSON is ignored", async () => {
    await startLeaderElection()
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "cognia-scheduler-leader-heartbeat",
        newValue: "{not-json",
      })
    )
    // Leadership unchanged.
    expect(isLeaderTab()).toBe(true)
  })

  it("storage event for unrelated key is ignored", async () => {
    await startLeaderElection()
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "unrelated-key",
        newValue: JSON.stringify({ tabId: "x", timestamp: Date.now() }),
      })
    )
    expect(isLeaderTab()).toBe(true)
  })

  it("storage event with our own tabId does not flip leadership", async () => {
    await startLeaderElection()
    const me = getTabId()
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "cognia-scheduler-leader-heartbeat",
        newValue: JSON.stringify({ tabId: me, timestamp: Date.now() }),
      })
    )
    expect(isLeaderTab()).toBe(true)
  })

  it("writeHeartbeat tolerates quota errors", async () => {
    delete (navigator as unknown as { locks?: unknown }).locks
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = jest.fn(() => {
      throw new Error("quota")
    })
    try {
      await startLeaderElection()
      // Even though the write threw, fallback assumes leader.
      expect(isLeaderTab()).toBe(true)
    } finally {
      Storage.prototype.setItem = original
    }
  })

  it("removes its heartbeat row on stop", async () => {
    await startLeaderElection()
    expect(localStorage.getItem("cognia-scheduler-leader-heartbeat")).toBeTruthy()
    stopLeaderElection()
    expect(localStorage.getItem("cognia-scheduler-leader-heartbeat")).toBeNull()
  })

  it("does not remove other tabs heartbeat on stop", async () => {
    // First, claim leader so we register the storage handler & set a hb.
    await startLeaderElection()
    // Now overwrite the heartbeat to simulate another tab beating us out.
    localStorage.setItem(
      "cognia-scheduler-leader-heartbeat",
      JSON.stringify({ tabId: "someone-else", timestamp: Date.now() })
    )
    stopLeaderElection()
    // Heartbeat for someone-else stays.
    expect(localStorage.getItem("cognia-scheduler-leader-heartbeat")).toContain("someone-else")
  })

  it("stop ignores localStorage errors", async () => {
    await startLeaderElection()
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = jest.fn(() => {
      throw new Error("boom")
    })
    try {
      expect(() => stopLeaderElection()).not.toThrow()
    } finally {
      Storage.prototype.getItem = original
    }
  })
})

describe("BroadcastChannel and listeners", () => {
  beforeEach(() => {
    delete (navigator as unknown as { locks?: unknown }).locks
  })

  it("warns and continues when BroadcastChannel constructor throws", async () => {
    MockBroadcastChannel.throwOnConstruct = true
    await startLeaderElection()
    expect(isLeaderTab()).toBe(true)
  })

  it("responds to leader-claimed messages from other tabs", async () => {
    await startLeaderElection()
    expect(isLeaderTab()).toBe(true)
    const channel = MockBroadcastChannel.instances[0]
    channel.onmessage?.({ data: { type: "leader-claimed", tabId: "other" } })
    expect(isLeaderTab()).toBe(false)
  })

  it("ignores leader-claimed message from itself", async () => {
    await startLeaderElection()
    const me = getTabId()
    const channel = MockBroadcastChannel.instances[0]
    channel.onmessage?.({ data: { type: "leader-claimed", tabId: me } })
    expect(isLeaderTab()).toBe(true)
  })

  it("onLeaderChange notifies subscribers on add and update", async () => {
    const cb = jest.fn()
    const dispose = onLeaderChange(cb)
    expect(cb).toHaveBeenCalledWith(false)
    await startLeaderElection()
    expect(cb).toHaveBeenLastCalledWith(true)
    dispose()
  })

  it("onLeaderChange listener errors are isolated during state change", async () => {
    // Subscribe AFTER first leader claim so the immediate-notification
    // (which is not wrapped in try/catch) does not swallow the throw.
    await startLeaderElection()
    const flaky = jest.fn((isLeader: boolean) => {
      if (!isLeader) throw new Error("listener exploded")
    })
    // Initial subscribe sees current state (true) — no throw.
    onLeaderChange(flaky)
    // Now flip to follower via a foreign leader-claimed broadcast — that
    // path runs through setLeader() which IS wrapped in try/catch.
    const channel = MockBroadcastChannel.instances[0]
    channel.onmessage?.({ data: { type: "leader-claimed", tabId: "other" } })
    expect(flaky).toHaveBeenCalled()
    expect(isLeaderTab()).toBe(false)
  })

  it("disposing onLeaderChange stops further notifications", async () => {
    const cb = jest.fn()
    const dispose = onLeaderChange(cb)
    cb.mockClear()
    dispose()
    await startLeaderElection()
    expect(cb).not.toHaveBeenCalled()
  })
})
