import { createTuiInlineComplete, isAiSuggestEnabled, isLocalSuggestEnabled } from "./ai-complete"
import type { ResolvedConfig } from "../../config/schema"

const config = { cwd: "/repo" } as unknown as ResolvedConfig
const signal = () => new AbortController().signal

/** Deps that resolve a working client without touching Dexie or a provider. */
function deps(over: Partial<Parameters<typeof createTuiInlineComplete>[0]> = {}) {
  return {
    sessionId: "sess-1",
    config,
    ensureDb: jest.fn(async () => undefined),
    getSession: jest.fn(async () => ({ id: "sess-1" }) as never),
    resolveSettings: jest.fn(() => ({}) as never),
    buildClient: jest.fn(() => ({ complete: jest.fn(async () => " world") }) as never),
    ...over,
  }
}

describe("createTuiInlineComplete", () => {
  it("resolves a client and returns its completion", async () => {
    const complete = createTuiInlineComplete(deps())
    await expect(complete({ system: "s", prompt: "p", signal: signal() })).resolves.toBe(" world")
  })

  it("forwards the system prompt and abort signal to the client", async () => {
    const clientComplete = jest.fn(async () => " world")
    const complete = createTuiInlineComplete(
      deps({ buildClient: () => ({ complete: clientComplete }) as never })
    )
    const controller = new AbortController()
    await complete({ system: "sys", prompt: "prompt", signal: controller.signal })
    expect(clientComplete).toHaveBeenCalledWith(
      "prompt",
      expect.objectContaining({ system: "sys", abortSignal: controller.signal })
    )
  })

  it("resolves the client only once across many keystrokes", async () => {
    const d = deps()
    const complete = createTuiInlineComplete(d)
    await complete({ system: "s", prompt: "a", signal: signal() })
    await complete({ system: "s", prompt: "b", signal: signal() })
    await complete({ system: "s", prompt: "c", signal: signal() })
    expect(d.getSession).toHaveBeenCalledTimes(1)
    expect(d.buildClient).toHaveBeenCalledTimes(1)
  })

  it("shares one resolution between concurrent calls", async () => {
    const d = deps()
    const complete = createTuiInlineComplete(d)
    await Promise.all([
      complete({ system: "s", prompt: "a", signal: signal() }),
      complete({ system: "s", prompt: "b", signal: signal() }),
    ])
    expect(d.getSession).toHaveBeenCalledTimes(1)
  })

  it("returns null when no client can be built, and caches that outcome", async () => {
    const d = deps({ buildClient: jest.fn(() => null) })
    const complete = createTuiInlineComplete(d)
    await expect(complete({ system: "s", prompt: "p", signal: signal() })).resolves.toBeNull()
    await expect(complete({ system: "s", prompt: "q", signal: signal() })).resolves.toBeNull()
    // A user without credentials must not re-hit Dexie on every keystroke.
    expect(d.getSession).toHaveBeenCalledTimes(1)
  })

  it("returns null when session lookup throws", async () => {
    const complete = createTuiInlineComplete(
      deps({
        getSession: jest.fn(async () => {
          throw new Error("db unreadable")
        }),
      })
    )
    await expect(complete({ system: "s", prompt: "p", signal: signal() })).resolves.toBeNull()
  })

  it("returns null when the db cannot be opened", async () => {
    const complete = createTuiInlineComplete(
      deps({
        ensureDb: jest.fn(async () => {
          throw new Error("locked")
        }),
      })
    )
    await expect(complete({ system: "s", prompt: "p", signal: signal() })).resolves.toBeNull()
  })

  it("degrades to null when built with no injected seams", async () => {
    // Exercises the real `ensureCliDb` / `getSession` / `toBuildContext` /
    // `buildRendererLlmClient` defaults. None of them can resolve a client in a
    // unit-test environment, and the contract is that this is NORMAL — the
    // composer must fall back to the local tier, never throw into the render.
    const complete = createTuiInlineComplete({ sessionId: "sess-1", config })
    await expect(complete({ system: "s", prompt: "p", signal: signal() })).resolves.toBeNull()
  })

  it("skips the model call when the signal aborted during resolution", async () => {
    const clientComplete = jest.fn(async () => " world")
    const controller = new AbortController()
    const complete = createTuiInlineComplete(
      deps({
        getSession: jest.fn(async () => {
          controller.abort()
          return { id: "sess-1" } as never
        }),
        buildClient: () => ({ complete: clientComplete }) as never,
      })
    )
    await expect(
      complete({ system: "s", prompt: "p", signal: controller.signal })
    ).resolves.toBeNull()
    expect(clientComplete).not.toHaveBeenCalled()
  })
})

describe("suggest tier gating", () => {
  it("keeps the model tier off unless explicitly enabled", () => {
    expect(isAiSuggestEnabled({} as ResolvedConfig)).toBe(false)
    expect(isAiSuggestEnabled({ autosuggest: {} } as ResolvedConfig)).toBe(false)
    expect(isAiSuggestEnabled({ autosuggest: { ai: false } } as ResolvedConfig)).toBe(false)
    expect(isAiSuggestEnabled({ autosuggest: { ai: true } } as ResolvedConfig)).toBe(true)
  })

  it("keeps the free local tier on unless explicitly disabled", () => {
    expect(isLocalSuggestEnabled({} as ResolvedConfig)).toBe(true)
    expect(isLocalSuggestEnabled({ autosuggest: {} } as ResolvedConfig)).toBe(true)
    expect(isLocalSuggestEnabled({ autosuggest: { local: true } } as ResolvedConfig)).toBe(true)
    expect(isLocalSuggestEnabled({ autosuggest: { local: false } } as ResolvedConfig)).toBe(false)
  })
})
