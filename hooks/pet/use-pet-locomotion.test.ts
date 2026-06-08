import { act, renderHook } from "@testing-library/react"
import { mulberry32 } from "@/lib/pet/bones/prng"
import {
  usePetLocomotion,
  type PetLocomotionIo,
  type UsePetLocomotionArgs,
} from "./use-pet-locomotion"
import type { PetWanderSettings } from "@/types/pet"

// petSize 128 → overlay window 224×288 logical; scale 1 → ground top = 1000-288 = 712.
const AREA = { x: 0, y: 0, width: 2000, height: 1000, scaleFactor: 1 }
const GROUND = 712

const WANDER_ON: PetWanderSettings = {
  enabled: true,
  frequency: "normal",
  onlyAfterInteraction: false,
  range: "full",
}

/** Deterministic clock + manual rAF/timer queues standing in for the browser. */
function makeIo() {
  let now = 0
  let nextId = 1
  const rafs = new Map<number, () => void>()
  const timers = new Map<number, { cb: () => void; at: number }>()
  let surfaces: { x: number; y: number; width: number }[] = []

  const io: PetLocomotionIo = {
    getWorkArea: jest.fn(async () => AREA),
    getPosition: jest.fn(async () => ({ x: 500, y: GROUND })),
    setPosition: jest.fn(async () => true),
    getSurfaces: jest.fn(async () => surfaces),
    now: () => now,
    raf: (cb) => {
      const id = nextId++
      rafs.set(id, cb)
      return id
    },
    caf: (id) => void rafs.delete(id),
    setTimer: (cb, ms) => {
      const id = nextId++
      timers.set(id, { cb, at: now + ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (id) => void timers.delete(id as unknown as number),
    createRng: () => mulberry32(7),
  }

  /** Run every queued rAF once (each frame may queue the next). */
  const flushRaf = (dtMs = 16) => {
    now += dtMs
    const pending = [...rafs.entries()]
    rafs.clear()
    for (const [, cb] of pending) cb()
  }
  /** Advance the clock and fire due timers. */
  const advance = (ms: number) => {
    now += ms
    for (const [id, t] of [...timers.entries()]) {
      if (t.at <= now) {
        timers.delete(id)
        t.cb()
      }
    }
  }
  return {
    io,
    flushRaf,
    advance,
    rafCount: () => rafs.size,
    timerCount: () => timers.size,
    nowMs: () => now,
    setSurfaces: (s: { x: number; y: number; width: number }[]) => {
      surfaces = s
    },
  }
}

function makeArgs(
  io: PetLocomotionIo,
  partial: Partial<UsePetLocomotionArgs> = {}
): UsePetLocomotionArgs {
  return {
    enabled: true,
    paused: false,
    wander: WANDER_ON,
    lowPower: false,
    petSize: 128,
    lastInteractionAtMs: () => null,
    io,
    ...partial,
  }
}

/** Mount the hook and let the async position/work-area init settle. */
async function mount(
  harness: ReturnType<typeof makeIo>,
  partial: Partial<UsePetLocomotionArgs> = {}
) {
  const view = renderHook((p: UsePetLocomotionArgs) => usePetLocomotion(p), {
    initialProps: makeArgs(harness.io, partial),
  })
  await act(async () => {}) // flush the Promise.all init
  return view
}

describe("usePetLocomotion", () => {
  it("activates lazily: reads position + work area once, then parks on a rest timer (no rAF)", async () => {
    const h = makeIo()
    const view = await mount(h)
    expect(h.io.getPosition).toHaveBeenCalledTimes(1)
    expect(h.io.getWorkArea).toHaveBeenCalledTimes(1)
    // First frame draws the rest interval; second parks with a timer.
    await act(async () => h.flushRaf())
    await act(async () => h.flushRaf())
    expect(h.rafCount()).toBe(0)
    expect(h.timerCount()).toBe(1)
    expect(view.result.current.scaleFactor).toBe(1)
    expect(view.result.current.locomotion.mode).toBe("resting")
    expect(h.io.setPosition).not.toHaveBeenCalled()
  })

  it("walks after the rest elapses, streams window positions, then settles + persists", async () => {
    const h = makeIo()
    const onSettle = jest.fn()
    const view = await mount(h, { onSettle })
    await act(async () => h.flushRaf())
    await act(async () => h.flushRaf())

    // Fire the rest timer (rest intervals are 20–60s for "normal").
    await act(async () => h.advance(70_000))
    // The wake frame transitions resting → walking.
    await act(async () => h.flushRaf())
    expect(view.result.current.locomotion.mode).toBe("walking")

    // Stream frames until the walk completes (cap well above worst case).
    let frames = 0
    while (view.result.current.locomotion.mode === "walking" && frames < 10_000) {
      await act(async () => h.flushRaf(50))
      frames++
    }
    expect(view.result.current.locomotion.mode).toBe("resting")
    expect(h.io.setPosition).toHaveBeenCalled()
    // Settle persisted the resting position on the ground line.
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(onSettle.mock.calls[0][1]).toBe(GROUND)
    // Work area re-read after landing (monitor may have changed).
    expect(h.io.getWorkArea).toHaveBeenCalledTimes(2)
  })

  it("does not start at all while paused, and resumes when unpaused", async () => {
    const h = makeIo()
    const view = await mount(h, { paused: true })
    expect(h.io.getPosition).not.toHaveBeenCalled()
    expect(h.rafCount()).toBe(0)

    view.rerender(makeArgs(h.io, { paused: false }))
    await act(async () => {})
    expect(h.io.getPosition).toHaveBeenCalledTimes(1)
  })

  it("stops a walk in place when paused mid-walk and parks without a timer", async () => {
    const h = makeIo()
    const view = await mount(h)
    await act(async () => h.flushRaf())
    await act(async () => h.flushRaf())
    await act(async () => h.advance(70_000))
    await act(async () => h.flushRaf())
    expect(view.result.current.locomotion.mode).toBe("walking")

    view.rerender(makeArgs(h.io, { paused: true }))
    await act(async () => h.flushRaf())
    expect(view.result.current.locomotion.mode).toBe("resting")
    expect(h.rafCount()).toBe(0)
    expect(h.timerCount()).toBe(0)
  })

  it("beginThrow falls with gravity to the ground and persists even with wandering off", async () => {
    const h = makeIo()
    const onSettle = jest.fn()
    const view = await mount(h, {
      onSettle,
      wander: { ...WANDER_ON, enabled: false },
    })
    // Wander off → loop never activated; throw kicks it independently.
    await act(async () => {
      view.result.current.beginThrow(500, 100, 200, 0)
    })
    await act(async () => {}) // init position/area fetch
    let frames = 0
    while (onSettle.mock.calls.length === 0 && frames < 10_000) {
      await act(async () => h.flushRaf(16))
      frames++
    }
    expect(frames).toBeGreaterThan(0)
    expect(onSettle).toHaveBeenCalledTimes(1)
    const [, y] = onSettle.mock.calls[0] as [number, number]
    expect(y).toBe(GROUND)
    expect(h.io.setPosition).toHaveBeenCalled()
    // After settling with wander off, the loop parks dormant.
    expect(h.rafCount()).toBe(0)
    expect(h.timerCount()).toBe(0)
  })

  it("skips no-op integer positions (IPC coalescing)", async () => {
    const h = makeIo()
    await mount(h)
    await act(async () => h.flushRaf())
    await act(async () => h.flushRaf())
    // Resting frames never send a position.
    expect(h.io.setPosition).not.toHaveBeenCalled()
  })

  it("stays inert off Tauri (null position/work area)", async () => {
    const h = makeIo()
    ;(h.io.getWorkArea as jest.Mock).mockResolvedValue(null)
    ;(h.io.getPosition as jest.Mock).mockResolvedValue(null)
    const view = await mount(h)
    await act(async () => h.flushRaf())
    await act(async () => h.flushRaf())
    expect(view.result.current.locomotion.mode).toBe("resting")
    expect(h.io.setPosition).not.toHaveBeenCalled()
    expect(h.timerCount()).toBe(0)
  })

  it("cleans up rAF and timers on unmount", async () => {
    const h = makeIo()
    const view = await mount(h)
    await act(async () => h.flushRaf())
    await act(async () => h.flushRaf())
    expect(h.timerCount()).toBe(1)
    view.unmount()
    expect(h.timerCount()).toBe(0)
    expect(h.rafCount()).toBe(0)
  })

  it("never polls window surfaces when climbWindows is off", async () => {
    const h = makeIo()
    await mount(h)
    await act(async () => h.flushRaf())
    await act(async () => h.advance(4000))
    expect(h.io.getSurfaces).not.toHaveBeenCalled()
  })

  it("polls window surfaces on a low cadence when climbWindows is on", async () => {
    const h = makeIo()
    h.setSurfaces([{ x: 100, y: 300, width: 400 }])
    await mount(h, { wander: { ...WANDER_ON, climbWindows: true } })
    await act(async () => {}) // let the first poll's promise settle
    expect(h.io.getSurfaces).toHaveBeenCalled()
    const first = (h.io.getSurfaces as jest.Mock).mock.calls.length
    await act(async () => h.advance(1600)) // > SURFACES_POLL_MS → reschedules
    await act(async () => {})
    expect((h.io.getSurfaces as jest.Mock).mock.calls.length).toBeGreaterThan(first)
  })

  it("stops polling surfaces on unmount (climb on)", async () => {
    const h = makeIo()
    h.setSurfaces([{ x: 100, y: 300, width: 400 }])
    const view = await mount(h, { wander: { ...WANDER_ON, climbWindows: true } })
    await act(async () => {})
    view.unmount()
    const calls = (h.io.getSurfaces as jest.Mock).mock.calls.length
    await act(async () => h.advance(4000))
    expect((h.io.getSurfaces as jest.Mock).mock.calls.length).toBe(calls)
  })
})
