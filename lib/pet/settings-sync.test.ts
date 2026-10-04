/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: jest.fn(), setState: jest.fn() },
}))

import {
  PET_SETTINGS_CHANNEL,
  petSettingsRealmIdForTest,
  startPetSettingsFollower,
  updateDesktopPetSettings,
  updatePetSettings,
  type PetSettingsSyncDeps,
} from "./settings-sync"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

/** In-memory BroadcastChannel bus: every channel of one name sees the others. */
function createBus() {
  const listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  const posted: unknown[] = []
  let closed = 0
  const open: PetSettingsSyncDeps["openChannel"] = (name) => {
    const mine = new Set<(e: MessageEvent) => void>()
    const all = listeners.get(name) ?? new Set()
    listeners.set(name, all)
    return {
      postMessage: (data: unknown) => {
        posted.push(data)
        for (const l of all) if (!mine.has(l)) l({ data } as MessageEvent)
      },
      close: () => {
        closed += 1
        for (const l of mine) all.delete(l)
      },
      addEventListener: (_type: string, l: EventListenerOrEventListenerObject) => {
        const fn = l as unknown as (e: MessageEvent) => void
        mine.add(fn)
        all.add(fn)
      },
      removeEventListener: (_type: string, l: EventListenerOrEventListenerObject) => {
        const fn = l as unknown as (e: MessageEvent) => void
        mine.delete(fn)
        all.delete(fn)
      },
    }
  }
  return {
    open,
    posted,
    deliver: (name: string, data: unknown) => {
      for (const l of listeners.get(name) ?? []) l({ data } as MessageEvent)
    },
    closedCount: () => closed,
  }
}

function makeStore(initial: PetSettings) {
  let persisted = initial
  return {
    get: () => persisted,
    readPersisted: jest.fn(async () => persisted),
    write: jest.fn(async (next: PetSettings) => {
      persisted = next
    }),
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe("updatePetSettings", () => {
  it("applies the updater to the PERSISTED record, not a caller snapshot", async () => {
    const store = makeStore({ ...DEFAULT_PET_SETTINGS, size: 120 })
    const bus = createBus()
    // Another window changed the size after this window booted.
    await store.write({ ...store.get(), size: 160 })

    const result = await updatePetSettings((latest) => ({ ...latest, mutedBubbles: true }), {
      readPersisted: store.readPersisted,
      write: store.write,
      withLock: (task) => task(),
      openChannel: bus.open,
    })

    expect(result.size).toBe(160)
    expect(result.mutedBubbles).toBe(true)
    expect(store.get()).toEqual(result)
  })

  it("broadcasts one versioned change message carrying this realm's id", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const bus = createBus()
    await updatePetSettings((latest) => ({ ...latest, size: 140 }), {
      readPersisted: store.readPersisted,
      write: store.write,
      withLock: (task) => task(),
      openChannel: bus.open,
    })
    expect(bus.posted).toEqual([
      { v: 1, kind: "pet-settings-changed", from: petSettingsRealmIdForTest() },
    ])
    // The writer's short-lived channel is closed again.
    expect(bus.closedCount()).toBe(1)
  })

  it("writes and broadcasts nothing when the updater returns its input", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const bus = createBus()
    const result = await updatePetSettings((latest) => latest, {
      readPersisted: store.readPersisted,
      write: store.write,
      withLock: (task) => task(),
      openChannel: bus.open,
    })
    expect(store.write).not.toHaveBeenCalled()
    expect(bus.posted).toHaveLength(0)
    expect(result).toBe(store.get())
  })

  it("runs the whole read-modify-write inside the lock", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const order: string[] = []
    await updatePetSettings((latest) => ({ ...latest, size: 150 }), {
      readPersisted: async () => {
        order.push("read")
        return store.get()
      },
      write: async (next) => {
        order.push("write")
        await store.write(next)
      },
      withLock: async (task) => {
        order.push("lock")
        const out = await task()
        order.push("unlock")
        return out
      },
      openChannel: () => null,
    })
    expect(order).toEqual(["lock", "read", "write", "unlock"])
  })

  it("serializes concurrent writers so neither loses the other's field", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    let chain: Promise<unknown> = Promise.resolve()
    const withLock: PetSettingsSyncDeps["withLock"] = (task) => {
      const next = chain.then(task)
      chain = next.catch(() => undefined)
      return next
    }
    const deps = {
      readPersisted: store.readPersisted,
      write: store.write,
      withLock,
      openChannel: () => null,
    }
    await Promise.all([
      updatePetSettings((l) => ({ ...l, size: 200 }), deps),
      updatePetSettings((l) => ({ ...l, mutedBubbles: true }), deps),
    ])
    expect(store.get().size).toBe(200)
    expect(store.get().mutedBubbles).toBe(true)
  })

  it("falls back to an in-realm queue when the Web Lock API is missing", async () => {
    // jsdom has no navigator.locks — the default lock must still serialize.
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const deps = { readPersisted: store.readPersisted, write: store.write, openChannel: () => null }
    await Promise.all([
      updatePetSettings((l) => ({ ...l, size: 180 }), deps),
      updatePetSettings((l) => ({ ...l, lowPower: true }), deps),
    ])
    expect(store.get().size).toBe(180)
    expect(store.get().lowPower).toBe(true)
  })

  it("uses navigator.locks when present", async () => {
    const request = jest.fn((_name: string, _opts: unknown, task: () => Promise<unknown>) => task())
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true })
    try {
      const store = makeStore(DEFAULT_PET_SETTINGS)
      await updatePetSettings((l) => ({ ...l, size: 130 }), {
        readPersisted: store.readPersisted,
        write: store.write,
        openChannel: () => null,
      })
      expect(request).toHaveBeenCalledWith(
        "cognia-pet-settings-write",
        { mode: "exclusive" },
        expect.any(Function)
      )
      expect(store.get().size).toBe(130)
    } finally {
      delete (navigator as unknown as { locks?: unknown }).locks
    }
  })
})

describe("updateDesktopPetSettings", () => {
  it("merges into the fresh nested record, keeping another window's position", async () => {
    const store = makeStore({
      ...DEFAULT_PET_SETTINGS,
      desktopPet: { ...DEFAULT_PET_DESKTOP_OVERLAY, enabled: true, position: { x: 10, y: 20 } },
    })
    const result = await updateDesktopPetSettings(
      () => ({ clickThrough: true }),
      DEFAULT_PET_DESKTOP_OVERLAY,
      {
        readPersisted: store.readPersisted,
        write: store.write,
        withLock: (task) => task(),
        openChannel: () => null,
      }
    )
    expect(result.desktopPet).toEqual({
      ...DEFAULT_PET_DESKTOP_OVERLAY,
      enabled: true,
      position: { x: 10, y: 20 },
      clickThrough: true,
    })
  })

  it("seeds the defaults when the nested record is absent", async () => {
    const store = makeStore({ ...DEFAULT_PET_SETTINGS, desktopPet: undefined })
    const result = await updateDesktopPetSettings(
      () => ({ size: 192 }),
      DEFAULT_PET_DESKTOP_OVERLAY,
      {
        readPersisted: store.readPersisted,
        write: store.write,
        withLock: (task) => task(),
        openChannel: () => null,
      }
    )
    expect(result.desktopPet).toEqual({ ...DEFAULT_PET_DESKTOP_OVERLAY, size: 192 })
  })
})

describe("startPetSettingsFollower", () => {
  it("re-reads and applies the persisted record when another window writes", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const bus = createBus()
    const applyLocal = jest.fn()
    const dispose = startPetSettingsFollower({
      readPersisted: store.readPersisted,
      openChannel: bus.open,
      applyLocal,
    })
    await store.write({ ...store.get(), size: 210 })
    bus.deliver(PET_SETTINGS_CHANNEL, { v: 1, kind: "pet-settings-changed", from: "other" })
    await flush()
    expect(applyLocal).toHaveBeenCalledWith(expect.objectContaining({ size: 210 }))
    dispose()
  })

  it("ignores its own realm's writes and malformed messages", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const bus = createBus()
    const applyLocal = jest.fn()
    const dispose = startPetSettingsFollower({
      readPersisted: store.readPersisted,
      openChannel: bus.open,
      applyLocal,
    })
    bus.deliver(PET_SETTINGS_CHANNEL, {
      v: 1,
      kind: "pet-settings-changed",
      from: petSettingsRealmIdForTest(),
    })
    bus.deliver(PET_SETTINGS_CHANNEL, { v: 2, kind: "pet-settings-changed", from: "x" })
    bus.deliver(PET_SETTINGS_CHANNEL, "garbage")
    bus.deliver(PET_SETTINGS_CHANNEL, null)
    await flush()
    expect(applyLocal).not.toHaveBeenCalled()
    dispose()
  })

  it("coalesces a burst of writes into a trailing read", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const bus = createBus()
    const applyLocal = jest.fn()
    let release: () => void = () => {}
    const readPersisted = jest.fn(
      () =>
        new Promise<PetSettings>((resolve) => {
          release = () => resolve(store.get())
        })
    )
    const dispose = startPetSettingsFollower({ readPersisted, openChannel: bus.open, applyLocal })
    const msg = { v: 1, kind: "pet-settings-changed", from: "other" }
    bus.deliver(PET_SETTINGS_CHANNEL, msg)
    bus.deliver(PET_SETTINGS_CHANNEL, msg)
    bus.deliver(PET_SETTINGS_CHANNEL, msg)
    expect(readPersisted).toHaveBeenCalledTimes(1)
    release()
    await flush()
    // One trailing read covers the two messages that arrived mid-read.
    expect(readPersisted).toHaveBeenCalledTimes(2)
    release()
    await flush()
    expect(applyLocal).toHaveBeenCalledTimes(2)
    dispose()
  })

  it("stops applying after dispose and closes its channel", async () => {
    const store = makeStore(DEFAULT_PET_SETTINGS)
    const bus = createBus()
    const applyLocal = jest.fn()
    const dispose = startPetSettingsFollower({
      readPersisted: store.readPersisted,
      openChannel: bus.open,
      applyLocal,
    })
    dispose()
    expect(bus.closedCount()).toBe(1)
    bus.deliver(PET_SETTINGS_CHANNEL, { v: 1, kind: "pet-settings-changed", from: "other" })
    await flush()
    expect(applyLocal).not.toHaveBeenCalled()
  })

  it("is a no-op where BroadcastChannel is unavailable", () => {
    const dispose = startPetSettingsFollower({ openChannel: () => null })
    expect(() => dispose()).not.toThrow()
  })

  it("keeps following after a failed re-read", async () => {
    const bus = createBus()
    const applyLocal = jest.fn()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const readPersisted = jest
      .fn<Promise<PetSettings>, []>()
      .mockRejectedValueOnce(new Error("db closed"))
      .mockResolvedValue(DEFAULT_PET_SETTINGS)
    const dispose = startPetSettingsFollower({ readPersisted, openChannel: bus.open, applyLocal })
    const msg = { v: 1, kind: "pet-settings-changed", from: "other" }
    bus.deliver(PET_SETTINGS_CHANNEL, msg)
    await flush()
    expect(applyLocal).not.toHaveBeenCalled()
    bus.deliver(PET_SETTINGS_CHANNEL, msg)
    await flush()
    expect(applyLocal).toHaveBeenCalledWith(DEFAULT_PET_SETTINGS)
    warn.mockRestore()
    dispose()
  })
})

describe("default deps", () => {
  it("replaces only the petSettings slice of a loaded store", async () => {
    const { useSettingsStore } = jest.requireMock("@/stores/settings") as {
      useSettingsStore: { setState: jest.Mock; getState: jest.Mock }
    }
    const { getSettings } = jest.requireMock("@/lib/db/settings") as { getSettings: jest.Mock }
    const fresh = { ...DEFAULT_PET_SETTINGS, size: 222 }
    getSettings.mockResolvedValue({ petSettings: fresh })
    const bus = createBus()
    const dispose = startPetSettingsFollower({ openChannel: bus.open })
    bus.deliver(PET_SETTINGS_CHANNEL, { v: 1, kind: "pet-settings-changed", from: "other" })
    await flush()
    const updater = useSettingsStore.setState.mock.calls[0][0] as (s: unknown) => unknown
    expect(updater({ settings: { theme: "dark", petSettings: DEFAULT_PET_SETTINGS } })).toEqual({
      settings: { theme: "dark", petSettings: fresh },
    })
    // A store that never loaded is left alone rather than half-populated.
    const unloaded = { settings: null }
    expect(updater(unloaded)).toBe(unloaded)
    dispose()
  })

  it("writes through the settings store's save", async () => {
    const { useSettingsStore } = jest.requireMock("@/stores/settings") as {
      useSettingsStore: { getState: jest.Mock }
    }
    const { getSettings } = jest.requireMock("@/lib/db/settings") as { getSettings: jest.Mock }
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.getState.mockReturnValue({ save })
    getSettings.mockResolvedValue({ petSettings: undefined })
    const next = await updatePetSettings((l) => ({ ...l, size: 111 }), {
      withLock: (task) => task(),
      openChannel: () => null,
    })
    expect(save).toHaveBeenCalledWith({ petSettings: { ...DEFAULT_PET_SETTINGS, size: 111 } })
    expect(next.size).toBe(111)
  })
})
