import {
  __setModelSurfaceDepsForTests,
  cachedAgentModelSurface,
  forgetAgentModelSurface,
  loadAgentModelSurface,
} from "./model-surface-cache"
import {
  EMPTY_THINKING_SURFACE,
  type ExternalAgentModelSurface,
  type ExternalAgentThinkingSurface,
} from "./session-models"
import type { ExternalAgentSessionSurface } from "./model-surface-cache"

const SURFACE: ExternalAgentModelSurface = {
  choices: [{ modelId: "anthropic/sonnet", name: "Sonnet" }],
  currentModelId: "anthropic/sonnet",
  write: { kind: "config-option", optionId: "model" },
}

const THINKING: ExternalAgentThinkingSurface = {
  levels: ["low", "medium", "high", "xhigh", "max"],
  currentLevel: "medium",
  write: { kind: "config-option", optionId: "thinking" },
}

/** The reply shape the manager returns: both axes, from one round trip. */
function reply(surface: ExternalAgentModelSurface = SURFACE): {
  status: "ok"
  data: ExternalAgentSessionSurface
} {
  return { status: "ok", data: { models: surface, thinking: THINKING } }
}

describe("loadAgentModelSurface", () => {
  let restore: (() => void) | undefined

  beforeEach(() => {
    forgetAgentModelSurface()
  })

  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it("asks once and serves the rest from cache", () => {
    const fetchSurface = jest.fn().mockResolvedValue(reply())
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    return loadAgentModelSurface("a", "s")
      .then(() => loadAgentModelSurface("a", "s"))
      .then((second) => {
        expect(fetchSurface).toHaveBeenCalledTimes(1)
        expect(second).toEqual({ status: "ready", surface: SURFACE, thinking: THINKING })
        expect(cachedAgentModelSurface("a", "s")).toEqual(second)
      })
  })

  it("shares one in-flight request between the composer and the panel", async () => {
    // Both mount together in the chat view. For Pi the fetch is a real RPC to a
    // real process, so the duplicate is not free.
    const fetchSurface = jest.fn().mockResolvedValue(reply())
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    await Promise.all([loadAgentModelSurface("a", "s"), loadAgentModelSurface("a", "s")])
    expect(fetchSurface).toHaveBeenCalledTimes(1)
  })

  it("re-asks on refresh, which is what a write must do", async () => {
    const fetchSurface = jest.fn().mockResolvedValue(reply())
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    await loadAgentModelSurface("a", "s")
    await loadAgentModelSurface("a", "s", { refresh: true })
    expect(fetchSurface).toHaveBeenCalledTimes(2)
  })

  it("keeps each session separate", async () => {
    const fetchSurface = jest.fn().mockResolvedValue(reply())
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    await loadAgentModelSurface("a", "s1")
    await loadAgentModelSurface("a", "s2")
    expect(fetchSurface).toHaveBeenCalledTimes(2)
  })

  it("reports an unsupported agent as unsupported, with an empty surface", async () => {
    restore = __setModelSurfaceDepsForTests({
      fetchSurface: jest.fn().mockResolvedValue({ status: "unsupported" }),
    })
    const result = await loadAgentModelSurface("a", "s")
    expect(result.status).toBe("unsupported")
    expect(result.surface.choices).toEqual([])
    expect(result.surface.write).toEqual({ kind: "none" })
    // Empty rather than absent: an agent with no model control can still be
    // asked to think harder, and the effort chip reads this field directly.
    expect(result.thinking).toEqual(EMPTY_THINKING_SURFACE)
  })

  it("never rejects, because the caller is an effect", async () => {
    // A throw here would surface as an unhandled rejection from whichever
    // effect kicked the load off, which is not a place a user can act on.
    restore = __setModelSurfaceDepsForTests({
      fetchSurface: jest.fn().mockRejectedValue(new Error("agent went away")),
    })
    const result = await loadAgentModelSurface("a", "s")
    expect(result.status).toBe("error")
    expect(result.detail).toBe("agent went away")
  })

  it("forgets one agent without forgetting the others", async () => {
    // A reconnect can be a different process with a different model list, so
    // answering from the old one would offer models the new agent lacks.
    const fetchSurface = jest.fn().mockResolvedValue(reply())
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    await loadAgentModelSurface("a", "s")
    await loadAgentModelSurface("b", "s")
    forgetAgentModelSurface("a")

    expect(cachedAgentModelSurface("a", "s")).toBeNull()
    expect(cachedAgentModelSurface("b", "s")).not.toBeNull()
    await loadAgentModelSurface("a", "s")
    expect(fetchSurface).toHaveBeenCalledTimes(3)
  })

  it("caches the thinking ladder alongside the models, from one fetch", async () => {
    // The effort chip and the model picker mount together and read the same
    // entry. Serving thinking from a second round trip is what the shared
    // reply exists to avoid.
    const fetchSurface = jest.fn().mockResolvedValue(reply())
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    await loadAgentModelSurface("a", "s")
    expect(cachedAgentModelSurface("a", "s")?.thinking).toEqual(THINKING)
    expect(fetchSurface).toHaveBeenCalledTimes(1)
  })

  it("answers null for a pair nothing has loaded", () => {
    expect(cachedAgentModelSurface("never", "asked")).toBeNull()
  })

  it("lets the newest load win, however the two settle", async () => {
    // The composer mounts and loads, the user picks a model and `select` fires
    // a refresh. Whichever request is slower used to write the cache last, so
    // the pre-write answer could land on top of the fresh one.
    const older = deferred()
    const newer = deferred()
    const fetchSurface = jest
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    restore = __setModelSurfaceDepsForTests({ fetchSurface })

    const first = loadAgentModelSurface("a", "s")
    const second = loadAgentModelSurface("a", "s", { refresh: true })

    newer.resolve(reply({ ...SURFACE, currentModelId: "after-the-write" }))
    await second
    older.resolve(reply({ ...SURFACE, currentModelId: "before-the-write" }))
    await first

    expect(cachedAgentModelSurface("a", "s")?.surface.currentModelId).toBe("after-the-write")
  })

  it("does not let an in-flight load repopulate what a disconnect dropped", async () => {
    // `forgetAgentModelSurface` runs on disconnect, while a fetch started
    // before it is still outstanding. Landing that answer afterwards would put
    // the previous process's model list back for the next connect to read.
    const pending = deferred()
    restore = __setModelSurfaceDepsForTests({ fetchSurface: jest.fn(() => pending.promise) })

    const inFlight = loadAgentModelSurface("a", "s")
    forgetAgentModelSurface("a")
    pending.resolve(reply())
    await inFlight

    expect(cachedAgentModelSurface("a", "s")).toBeNull()
  })
})

/** A promise whose settlement this test controls. */
function deferred(): {
  promise: Promise<{ status: "ok"; data: ExternalAgentSessionSurface }>
  resolve: (value: { status: "ok"; data: ExternalAgentSessionSurface }) => void
} {
  let resolve!: (value: { status: "ok"; data: ExternalAgentSessionSurface }) => void
  const promise = new Promise<{ status: "ok"; data: ExternalAgentSessionSurface }>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
