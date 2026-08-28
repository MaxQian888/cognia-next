import {
  AGENT_PROVIDER_ID,
  AI_PROVIDER_ID,
  createAgentCompletionProvider,
  createAiCompletionProvider,
  type InlineCompleteFn,
} from "./ai-provider"
import type { InlineCompletionContext } from "./types"

function ctx(draft: string, overrides: Partial<InlineCompletionContext> = {}) {
  return {
    draft,
    caret: draft.length,
    history: [],
    commands: [],
    surface: "gui" as const,
    ...overrides,
  }
}

/** A `complete` that always returns the same raw model text. */
function constantComplete(raw: string | null): InlineCompleteFn {
  return async () => raw
}

const signal = () => new AbortController().signal

describe("createAiCompletionProvider", () => {
  it("is declared async so the engine debounces and caches it", () => {
    expect(createAiCompletionProvider({ complete: constantComplete("x") }).sync).toBe(false)
  })

  it("turns a model continuation into a full completed draft", async () => {
    const provider = createAiCompletionProvider({
      complete: constantComplete("the build please"),
      isPiiSafe: () => true,
    })
    const out = await provider.getCompletions(ctx("fix "), signal())
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("fix the build please")
    expect(out[0].source).toBe("ai")
    expect(out[0].providerId).toBe(AI_PROVIDER_ID)
  })

  it("passes the draft and recent messages into the prompt", async () => {
    const complete = jest.fn<ReturnType<InlineCompleteFn>, Parameters<InlineCompleteFn>>(
      async () => "more"
    )
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    await provider.getCompletions(
      ctx("fix ", { recentMessages: [{ role: "assistant", text: "Build is red." }] }),
      signal()
    )
    const { prompt, system } = complete.mock.calls[0][0]
    expect(system).toContain("autocomplete")
    expect(prompt).toContain("Build is red.")
    expect(prompt).toContain("fix ")
  })

  it("can be built as an agent-backed source that outranks plain AI", async () => {
    const provider = createAiCompletionProvider({
      complete: constantComplete("the build"),
      isPiiSafe: () => true,
      id: "builtin:agent",
      label: "Agent",
      source: "agent",
    })
    const out = await provider.getCompletions(ctx("fix "), signal())
    expect(out[0].source).toBe("agent")
    expect(out[0].providerId).toBe("builtin:agent")
    expect(out[0].detail).toBe("Agent")
  })

  it("skips the call below the minimum draft length", async () => {
    const complete = jest.fn(constantComplete("x"))
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    expect(await provider.getCompletions(ctx("fi"), signal())).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("skips the call while the draft is a lone slash command", async () => {
    const complete = jest.fn(constantComplete("x"))
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    expect(await provider.getCompletions(ctx("/compa"), signal())).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("still completes a slash line once it has arguments (it is prose again)", async () => {
    const provider = createAiCompletionProvider({
      complete: constantComplete("now"),
      isPiiSafe: () => true,
    })
    const out = await provider.getCompletions(ctx("/goal ship "), signal())
    expect(out[0].text).toBe("/goal ship now")
  })

  it("skips the call when the PII gate rejects the prompt", async () => {
    const complete = jest.fn(constantComplete("x"))
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => false })
    expect(await provider.getCompletions(ctx("fix "), signal())).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("uses the shared redactor when no gate is injected", async () => {
    // A draft carrying a credential must never reach the model on the default path.
    const complete = jest.fn(constantComplete("x"))
    const provider = createAiCompletionProvider({ complete })
    await provider.getCompletions(ctx("my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAA "), signal())
    expect(complete).not.toHaveBeenCalled()
  })

  it("returns nothing when the model throws", async () => {
    const provider = createAiCompletionProvider({
      complete: async () => {
        throw new Error("upstream down")
      },
      isPiiSafe: () => true,
    })
    expect(await provider.getCompletions(ctx("fix "), signal())).toEqual([])
  })

  it("returns nothing when the model yields null", async () => {
    const provider = createAiCompletionProvider({
      complete: constantComplete(null),
      isPiiSafe: () => true,
    })
    expect(await provider.getCompletions(ctx("fix "), signal())).toEqual([])
  })

  it("returns nothing when the reply sanitises away to nothing", async () => {
    const provider = createAiCompletionProvider({
      complete: constantComplete("   "),
      isPiiSafe: () => true,
    })
    expect(await provider.getCompletions(ctx("fix "), signal())).toEqual([])
  })

  it("returns nothing when the signal is already aborted", async () => {
    const complete = jest.fn(constantComplete("x"))
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    const controller = new AbortController()
    controller.abort()
    expect(await provider.getCompletions(ctx("fix "), controller.signal)).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it("discards a reply that arrived after the signal aborted", async () => {
    const controller = new AbortController()
    const provider = createAiCompletionProvider({
      complete: async () => {
        controller.abort()
        return "the build"
      },
      isPiiSafe: () => true,
    })
    expect(await provider.getCompletions(ctx("fix "), controller.signal)).toEqual([])
  })

  it("reports the configured confidence score", async () => {
    const provider = createAiCompletionProvider({
      complete: constantComplete("the build"),
      isPiiSafe: () => true,
      score: 0.42,
    })
    const out = await provider.getCompletions(ctx("fix "), signal())
    expect(out[0].score).toBe(0.42)
  })
})

describe("createAgentCompletionProvider", () => {
  const complete: InlineCompleteFn = async () => "the staging build"

  it("is manual, so the engine keeps it off the keystroke path", () => {
    const p = createAgentCompletionProvider({ complete })
    expect(p.manual).toBe(true)
    expect(p.id).toBe(AGENT_PROVIDER_ID)
    expect(p.id).not.toBe(AI_PROVIDER_ID)
  })

  it("labels its suggestions `agent`, which outranks `ai`", async () => {
    const p = createAgentCompletionProvider({ complete })
    const [s] = await p.getCompletions(ctx("deploy "), new AbortController().signal)
    expect(s.source).toBe("agent")
    expect(s.text).toBe("deploy the staging build")
    expect(s.detail).toBe("agent")
  })

  it("cannot be talked out of being manual by a caller", () => {
    // `source` and `manual` are Omit-ed from the options type, but a JS caller
    // can still pass them; the factory must win.
    const p = createAgentCompletionProvider({
      complete,
      ...({ manual: false, source: "ai" } as unknown as Record<string, never>),
    })
    expect(p.manual).toBe(true)
  })

  it("still honours the PII gate", async () => {
    const p = createAgentCompletionProvider({ complete, isPiiSafe: () => false })
    const out = await p.getCompletions(ctx("deploy "), new AbortController().signal)
    expect(out).toEqual([])
  })
})
