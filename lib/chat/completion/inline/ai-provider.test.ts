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
    expect(system).toContain("inline completions")
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

  it("retries a failed call once, then rethrows so the engine can flag the round", async () => {
    // Swallowing the error would read as "no suggestions" and could neither be
    // surfaced nor retried — the engine owns the error state, so the provider
    // reports the failure after its one transient-failure retry is spent.
    const complete = jest.fn(constantComplete(null)).mockRejectedValue(new Error("upstream down"))
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    await expect(provider.getCompletions(ctx("fix "), signal())).rejects.toThrow("upstream down")
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("recovers when the retry succeeds", async () => {
    const complete = jest
      .fn<ReturnType<InlineCompleteFn>, Parameters<InlineCompleteFn>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("the build")
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    const out = await provider.getCompletions(ctx("fix "), signal())
    expect(out[0].text).toBe("fix the build")
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("does not retry a call that was aborted", async () => {
    // An abort is the user moving on — the desired outcome, not a failure.
    const controller = new AbortController()
    const complete = jest.fn(async () => {
      controller.abort()
      throw new Error("aborted mid-flight")
    })
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    expect(await provider.getCompletions(ctx("fix "), controller.signal)).toEqual([])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it("returns nothing when the signal aborts during the retry delay", async () => {
    const controller = new AbortController()
    const complete = jest.fn(async () => {
      // Reject, then abort while the provider waits out its backoff — the
      // delay is abortable, so this resolves fast instead of after 700ms.
      setTimeout(() => controller.abort(), 0)
      throw new Error("blip")
    })
    const provider = createAiCompletionProvider({ complete, isPiiSafe: () => true })
    expect(await provider.getCompletions(ctx("fix "), controller.signal)).toEqual([])
    expect(complete).toHaveBeenCalledTimes(1)
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

  describe("streaming", () => {
    /** An async iterable from a list of deltas — the `LlmClient.stream` shape. */
    function streamOf(deltas: string[]): () => AsyncIterable<string> {
      return async function* () {
        for (const d of deltas) yield d
      }
    }

    it("emits the accumulated, sanitised text as it streams, then returns it settled", async () => {
      const emitted: string[][] = []
      const provider = createAiCompletionProvider({
        complete: constantComplete(null),
        stream: () => streamOf(["the ", "build", " please"])(),
        isPiiSafe: () => true,
      })
      const out = await provider.getCompletions(ctx("fix "), signal(), (partials) =>
        emitted.push(partials.map((s) => s.text))
      )
      // Each emit is the whole grown candidate, not a delta. `sanitizeGhost`
      // trims a trailing space mid-stream, so "the " paints as "the" and the
      // space lands with the next chunk.
      expect(emitted).toEqual([["fix the"], ["fix the build"], ["fix the build please"]])
      expect(out[0].text).toBe("fix the build please")
      // The candidate's identity is stable across emissions — the engine pins
      // by it while `text` mutates.
      expect(out[0].id).toBe(`${AI_PROVIDER_ID}:0`)
    })

    it("skips emissions that sanitise to nothing but still settles on the final text", async () => {
      const emitted: string[][] = []
      const provider = createAiCompletionProvider({
        complete: constantComplete(null),
        // A leading newline chunk sanitises to null — nothing painted yet.
        stream: () => streamOf(["\n", "the build"])(),
        isPiiSafe: () => true,
      })
      const out = await provider.getCompletions(ctx("fix "), signal(), (partials) =>
        emitted.push(partials.map((s) => s.text))
      )
      expect(emitted).toEqual([["fix the build"]])
      expect(out[0].text).toBe("fix the build")
    })

    it("falls back to `complete` when the client cannot stream", async () => {
      const complete = jest.fn(constantComplete("the build"))
      const provider = createAiCompletionProvider({
        complete,
        stream: () => null,
        isPiiSafe: () => true,
      })
      const emit = jest.fn()
      const out = await provider.getCompletions(ctx("fix "), signal(), emit)
      expect(out[0].text).toBe("fix the build")
      expect(complete).toHaveBeenCalledTimes(1)
      expect(emit).not.toHaveBeenCalled()
    })

    it("still returns the settled suggestion when no emit channel is given", async () => {
      const provider = createAiCompletionProvider({
        complete: constantComplete(null),
        stream: () => streamOf(["the build"])(),
        isPiiSafe: () => true,
      })
      const out = await provider.getCompletions(ctx("fix "), signal())
      expect(out[0].text).toBe("fix the build")
    })

    it("returns nothing when the stream produces no usable text", async () => {
      const provider = createAiCompletionProvider({
        complete: constantComplete(null),
        stream: () => streamOf(["", "  ", "\n"])(),
        isPiiSafe: () => true,
      })
      expect(await provider.getCompletions(ctx("fix "), signal())).toEqual([])
    })

    it("stops reading the stream once aborted", async () => {
      const controller = new AbortController()
      const emitted: string[][] = []
      const provider = createAiCompletionProvider({
        complete: constantComplete(null),
        stream: async function* () {
          yield "the "
          controller.abort()
          yield "build"
        },
        isPiiSafe: () => true,
      })
      const out = await provider.getCompletions(ctx("fix "), controller.signal, (p) =>
        emitted.push(p.map((s) => s.text))
      )
      // The abort cut the stream before "build" was accumulated or emitted.
      expect(emitted).toEqual([["fix the"]])
      expect(out).toEqual([])
    })

    it("retries a stream that fails mid-flight", async () => {
      let calls = 0
      const provider = createAiCompletionProvider({
        complete: constantComplete("fallback answer"),
        stream: () => {
          calls += 1
          if (calls === 1) {
            return (async function* () {
              yield "the "
              throw new Error("connection reset")
            })()
          }
          return streamOf(["the build"])()
        },
        isPiiSafe: () => true,
      })
      const emitted: string[][] = []
      const out = await provider.getCompletions(ctx("fix "), signal(), (p) =>
        emitted.push(p.map((s) => s.text))
      )
      expect(calls).toBe(2)
      // Attempt one's partial stayed painted through the retry — the card
      // never blanks — and the final candidate is the settled retry answer.
      expect(emitted[0]).toEqual(["fix the"])
      expect(out[0].text).toBe("fix the build")
    })
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
