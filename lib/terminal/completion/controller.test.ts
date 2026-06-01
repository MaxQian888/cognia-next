import { AutocompleteController, type AutocompleteScheduler } from "./controller"
import type { TerminalCompletionContext, TerminalCompletionSuggestion } from "./types"

/** A scheduler whose pending callback fires only when `flush()` is called. */
function manualScheduler() {
  let pending: (() => void) | null = null
  const scheduler: AutocompleteScheduler = {
    set: (fn) => {
      pending = fn
      return 1
    },
    clear: () => {
      pending = null
    },
  }
  return {
    scheduler,
    hasPending: () => pending !== null,
    flush: () => {
      const fn = pending
      pending = null
      return fn?.()
    },
  }
}

function baseCtx(input: string): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/x",
    input,
    cursor: input.length,
    recentCommands: [],
    platform: "linux",
  }
}

function sug(text: string): TerminalCompletionSuggestion {
  return { text, source: "ai", providerId: "builtin:ai", score: 0.7 }
}

function setup(query: jest.Mock) {
  const ms = manualScheduler()
  const onChange = jest.fn()
  const controller = new AutocompleteController({
    debounceMs: 50,
    getContext: (input) => baseCtx(input),
    query: query as never,
    onChange,
    scheduler: ms.scheduler,
  })
  return { controller, onChange, ...ms }
}

function type(controller: AutocompleteController, text: string) {
  for (const ch of text) controller.feed(ch)
}

describe("AutocompleteController", () => {
  it("queries after debounce and exposes the ghost suffix", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush, onChange } = setup(query)
    type(controller, "git ")
    expect(controller.getView().ghost).toBe("")
    await flush()
    expect(query).toHaveBeenCalledTimes(1)
    expect(controller.getView().ghost).toBe("status")
    expect(controller.getView().suggestion?.text).toBe("git status")
    expect(onChange).toHaveBeenCalled()
  })

  it("accept() returns the suffix, advances the line, and clears the suggestion", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    expect(controller.accept()).toBe("status")
    expect(controller.getView().ghost).toBe("")
    expect(controller.getView().suggestion).toBeNull()
  })

  it("accept() returns null when there is no suggestion", () => {
    const { controller } = setup(jest.fn(async () => []))
    type(controller, "ls")
    expect(controller.accept()).toBeNull()
  })

  it("dismiss() clears the active suggestion", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    controller.dismiss()
    expect(controller.getView().ghost).toBe("")
  })

  it("keeps a still-valid suggestion as you type, without re-querying", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush, hasPending } = setup(query)
    type(controller, "git ")
    await flush()
    controller.feed("s") // "git s" — still a prefix of "git status"
    expect(controller.getView().ghost).toBe("tatus")
    expect(hasPending()).toBe(false) // no new query scheduled
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("re-queries when the new input diverges from the suggestion", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([sug("git status")])
      .mockResolvedValueOnce([sug("git log")])
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    controller.feed("l") // "git l" diverges from "git status"
    expect(controller.getView().ghost).toBe("")
    await flush()
    expect(query).toHaveBeenCalledTimes(2)
    expect(controller.getView().ghost).toBe("og")
  })

  it("submit (Enter) clears the suggestion and resets", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    controller.feed("\r")
    expect(controller.getView().ghost).toBe("")
  })

  it("ignores a stale result if the input changed before it resolved", async () => {
    let resolveFn: (v: TerminalCompletionSuggestion[]) => void = () => {}
    const query = jest.fn(
      () => new Promise<TerminalCompletionSuggestion[]>((res) => (resolveFn = res))
    )
    const { controller, flush } = setup(query)
    type(controller, "git ")
    const p = flush() // starts the query (pending)
    controller.feed("x") // input now "git x"
    resolveFn([sug("git status")]) // resolves for the old input
    await p
    expect(controller.getView().suggestion).toBeNull()
  })

  it("does not suggest when the line is not suggestible (cursor not at end)", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, hasPending } = setup(query)
    type(controller, "git ")
    controller.feed("\x1b[D") // move cursor left → not at end
    expect(hasPending()).toBe(false)
    expect(controller.getView().ghost).toBe("")
  })

  it("reset() clears the line, suggestion, and pending query", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    expect(controller.input).toBe("git ")
    controller.reset()
    expect(controller.input).toBe("")
    expect(controller.getView().ghost).toBe("")
  })

  it("swallows a query that rejects and shows nothing", async () => {
    const query = jest.fn(async () => {
      throw new Error("provider blew up")
    })
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    expect(controller.getView().suggestion).toBeNull()
  })

  it("dispose() aborts the in-flight query signal", async () => {
    let captured: AbortSignal | null = null
    const query = jest.fn(async (_ctx: unknown, signal: AbortSignal) => {
      captured = signal
      return []
    })
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    controller.dispose()
    type(controller, "x")
    expect(captured).not.toBeNull()
  })
})
