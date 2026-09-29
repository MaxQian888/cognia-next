import { startVideoJobReconciler, VIDEO_JOB_LOCK_NAME } from "./reconciler"
import { createInMemoryMediaJobStore } from "./store"
import type { MediaGenerationJobRow } from "./types"
import type { VideoJobEngine } from "./engine"

function row(id: string, overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id,
    kind: "video",
    origin: { surface: "executor" },
    request: { prompt: "p" },
    provider: { providerId: "google", modelId: "veo", credentialAffinity: "a" },
    operation: {},
    status: "generating",
    pollCount: 0,
    nextPollAt: 100,
    deadlineAt: 10_000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeScheduler() {
  let tick: (() => void) | null = null
  return {
    scheduler: {
      setInterval: jest.fn((cb: () => void) => {
        tick = cb
        return 1
      }),
      clearInterval: jest.fn(),
    },
    fire: () => tick?.(),
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("startVideoJobReconciler", () => {
  it("checks every due job on each tick and skips the rest", async () => {
    const store = createInMemoryMediaJobStore()
    await store.insert(row("due", { nextPollAt: 100 }))
    await store.insert(row("later", { nextPollAt: 900 }))
    const poll = jest.fn(async () => undefined)
    const { scheduler, fire } = makeScheduler()
    const handle = startVideoJobReconciler({
      engine: () => ({ poll }) as unknown as VideoJobEngine,
      store: () => store,
      now: () => 500,
      scheduler,
      locks: null,
    })
    await flush()
    expect(poll).toHaveBeenCalledWith("due")
    expect(poll).not.toHaveBeenCalledWith("later")
    fire()
    await flush()
    expect(poll).toHaveBeenCalledTimes(2)
    handle.dispose()
    expect(scheduler.clearInterval).toHaveBeenCalled()
  })

  it("puts an interrupted download back to generating before polling", async () => {
    const store = createInMemoryMediaJobStore()
    await store.insert(row("stuck", { status: "downloading", nextPollAt: 99_999 }))
    const poll = jest.fn(async () => undefined)
    startVideoJobReconciler({
      engine: () => ({ poll }) as unknown as VideoJobEngine,
      store: () => store,
      now: () => 500,
      scheduler: makeScheduler().scheduler,
      locks: null,
    })
    await flush()
    await flush()
    expect(await store.get("stuck")).toMatchObject({ status: "generating", nextPollAt: 500 })
    expect(poll).toHaveBeenCalledWith("stuck")
  })

  it("only works while it holds the Web Lock, and releases it on dispose", async () => {
    let release: (() => void) | null = null
    let granted: (() => Promise<void>) | null = null
    const locks = {
      request: jest.fn(
        (name: string, options: { signal: AbortSignal }, cb: () => Promise<void>) => {
          granted = cb
          options.signal.addEventListener("abort", () => release?.())
          return new Promise((resolve) => {
            release = () => resolve(undefined)
          })
        }
      ),
    }
    const store = createInMemoryMediaJobStore()
    await store.insert(row("due"))
    const poll = jest.fn(async () => undefined)
    const { scheduler } = makeScheduler()
    const handle = startVideoJobReconciler({
      engine: () => ({ poll }) as unknown as VideoJobEngine,
      store: () => store,
      now: () => 500,
      scheduler,
      locks,
    })
    await flush()
    expect(locks.request).toHaveBeenCalledWith(
      VIDEO_JOB_LOCK_NAME,
      expect.anything(),
      expect.any(Function)
    )
    // Not the leader yet: nothing polled, no timer.
    expect(poll).not.toHaveBeenCalled()
    expect(scheduler.setInterval).not.toHaveBeenCalled()

    const holding = granted!()
    await flush()
    expect(poll).toHaveBeenCalledWith("due")
    expect(scheduler.setInterval).toHaveBeenCalled()
    handle.dispose()
    await expect(holding).resolves.toBeUndefined()
  })

  it("reports a failing poll without stopping the sweep", async () => {
    const store = createInMemoryMediaJobStore()
    await store.insert(row("a"))
    await store.insert(row("b"))
    const onError = jest.fn()
    const poll = jest.fn(async (id: string) => {
      if (id === "a") throw new Error("boom")
      return undefined
    })
    startVideoJobReconciler({
      engine: () => ({ poll }) as unknown as VideoJobEngine,
      store: () => store,
      now: () => 500,
      scheduler: makeScheduler().scheduler,
      locks: null,
      onError,
    })
    await flush()
    await flush()
    expect(poll).toHaveBeenCalledWith("b")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }))
  })
})
