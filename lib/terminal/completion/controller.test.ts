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
    projectId: null,
  }
}

function sug(text: string): TerminalCompletionSuggestion {
  return { text, source: "ai", providerId: "builtin:ai", score: 0.7 }
}

function replaceSug(text: string, from: number, insert: string): TerminalCompletionSuggestion {
  return { text, source: "path", providerId: "builtin:path", score: 0.7, replace: { from, insert } }
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
    expect(controller.getView().ghostSuggestion?.text).toBe("git status")
    expect(onChange).toHaveBeenCalled()
  })

  it("accept() returns the append edit, advances the line, and clears candidates", async () => {
    const query = jest.fn(async () => [sug("git status")])
    const { controller, flush } = setup(query)
    type(controller, "git ")
    await flush()
    expect(controller.accept()).toEqual({ backspaces: 0, write: "status" })
    expect(controller.input).toBe("git status")
    expect(controller.getView().ghost).toBe("")
    expect(controller.getView().ghostSuggestion).toBeNull()
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

  it("re-queries when the new input diverges from every candidate", async () => {
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
    expect(controller.getView().ghostSuggestion).toBeNull()
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
    expect(controller.getView().ghostSuggestion).toBeNull()
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

  describe("replace-mode suggestions", () => {
    it("accepts a token replacement with backspaces (case correction)", async () => {
      // input "cd doc", path provider re-cases to "Documents/"
      const query = jest.fn(async () => [replaceSug("cd Documents/", 3, "Documents/")])
      const { controller, flush } = setup(query)
      type(controller, "cd doc")
      await flush()
      // Mid-token replacement is not ghostable (it would lie about the prefix).
      expect(controller.getView().ghost).toBe("")
      controller.openList()
      expect(controller.getView().listOpen).toBe(true)
      expect(controller.acceptSelected()).toEqual({ backspaces: 3, write: "Documents/" })
      expect(controller.input).toBe("cd Documents/")
    })

    it("renders ghost text for a pure-suffix replace suggestion", async () => {
      const query = jest.fn(async () => [replaceSug("cd src/", 3, "src/")])
      const { controller, flush } = setup(query)
      type(controller, "cd ")
      await flush()
      expect(controller.getView().ghost).toBe("src/")
      expect(controller.accept()).toEqual({ backspaces: 0, write: "src/" })
    })

    it("drops a replace candidate that would discard typed characters", async () => {
      const query = jest.fn(async () => [replaceSug("cd src/", 3, "src/")])
      const { controller, flush } = setup(query)
      type(controller, "cd s")
      await flush()
      expect(controller.getView().candidates).toHaveLength(1)
      controller.feed("x") // "cd sx" — "src/" no longer matches the token
      expect(controller.getView().candidates).toHaveLength(0)
    })
  })

  describe("candidate popup", () => {
    const three = [sug("git status"), sug("git stash"), sug("git stage")]

    it("openList() exposes the candidates and moveSelection wraps", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      controller.openList()
      const v = controller.getView()
      expect(v.listOpen).toBe(true)
      expect(v.candidates.map((c) => c.text)).toEqual(three.map((c) => c.text))
      expect(v.selectedIndex).toBe(0)
      controller.moveSelection(1)
      expect(controller.getView().selectedIndex).toBe(1)
      controller.moveSelection(-2)
      expect(controller.getView().selectedIndex).toBe(2) // wrapped
      controller.moveSelection(1)
      expect(controller.getView().selectedIndex).toBe(0) // wrapped forward
    })

    it("acceptSelected() applies the highlighted candidate", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      controller.openList()
      controller.moveSelection(1)
      expect(controller.acceptSelected()).toEqual({ backspaces: 0, write: "ash" })
      expect(controller.input).toBe("git stash")
      expect(controller.getView().listOpen).toBe(false)
    })

    it("acceptSelected() returns null while the list is closed", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      expect(controller.acceptSelected()).toBeNull()
    })

    it("hides the ghost while the list is open", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      expect(controller.getView().ghost).toBe("atus")
      controller.openList()
      expect(controller.getView().ghost).toBe("")
      controller.closeList()
      expect(controller.getView().ghost).toBe("atus")
    })

    it("openList() with no candidates fires an immediate query", async () => {
      const query = jest.fn(async () => three)
      const { controller, hasPending } = setup(query)
      type(controller, "git st")
      expect(hasPending()).toBe(true) // debounce pending, not yet queried
      controller.openList()
      expect(hasPending()).toBe(false) // timer cancelled — query ran immediately
      expect(query).toHaveBeenCalledTimes(1)
      // Let the immediate query resolve, then the list shows candidates.
      await Promise.resolve()
      await Promise.resolve()
      expect(controller.getView().listOpen).toBe(true)
      expect(controller.getView().candidates).toHaveLength(3)
    })

    it("openList() is a no-op on a non-suggestible line", () => {
      const query = jest.fn(async () => three)
      const { controller } = setup(query)
      controller.openList()
      expect(controller.getView().listOpen).toBe(false)
      expect(query).not.toHaveBeenCalled()
    })

    it("typing narrows the open list and closes it when nothing survives", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      controller.openList()
      controller.feed("a") // "git sta" — all three still match
      controller.feed("s") // "git stas" — only "git stash" survives
      let v = controller.getView()
      expect(v.listOpen).toBe(true)
      expect(v.candidates.map((c) => c.text)).toEqual(["git stash"])
      controller.feed("x") // "git stasx" — nothing survives
      v = controller.getView()
      expect(v.listOpen).toBe(false)
      expect(v.candidates).toHaveLength(0)
    })

    it("keeps the highlighted candidate selected while the list narrows", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      controller.openList()
      controller.moveSelection(1) // highlight "git stash"
      controller.feed("a") // "git sta" — "git status" drops out
      const v = controller.getView()
      expect(v.candidates[v.selectedIndex]?.text).toBe("git stash")
    })

    it("Enter (submit) closes the list via reset semantics", async () => {
      const query = jest.fn(async () => three)
      const { controller, flush } = setup(query)
      type(controller, "git st")
      await flush()
      controller.openList()
      controller.feed("\r")
      expect(controller.getView().listOpen).toBe(false)
      expect(controller.getView().candidates).toHaveLength(0)
    })
  })
})
