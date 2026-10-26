import { useAskUserStore, runAskUser } from "./ask-user-store"

function reset() {
  useAskUserStore.setState({ active: null, queue: [] })
}

describe("useAskUserStore", () => {
  beforeEach(reset)

  it("makes the first request active and queues the second", async () => {
    const store = useAskUserStore.getState()
    void store.enqueue({ question: "q1", options: [], multiSelect: false, allowText: true })
    void store.enqueue({ question: "q2", options: [], multiSelect: false, allowText: true })
    const state = useAskUserStore.getState()
    expect(state.active?.request.question).toBe("q1")
    expect(state.queue).toHaveLength(1)
    expect(state.queue[0].request.question).toBe("q2")
  })

  it("resolves the active promise and promotes the queued one", async () => {
    const store = useAskUserStore.getState()
    const p1 = store.enqueue({ question: "q1", options: [], multiSelect: false, allowText: true })
    void store.enqueue({ question: "q2", options: [], multiSelect: false, allowText: true })

    useAskUserStore.getState().resolveActive({ selected: [], text: "first", cancelled: false })
    const a1 = await p1
    expect(a1.text).toBe("first")
    // q2 is now active.
    expect(useAskUserStore.getState().active?.request.question).toBe("q2")
  })

  it("resolveActive is a no-op when nothing is pending", () => {
    expect(() =>
      useAskUserStore.getState().resolveActive({ selected: [], text: "", cancelled: false })
    ).not.toThrow()
    expect(useAskUserStore.getState().active).toBeNull()
  })
})

describe("runAskUser", () => {
  beforeEach(reset)
  it("ignores an old signal after a successful answer while a sibling is active", async () => {
    const controller = new AbortController()
    const first = runAskUser({ question: "child" }, { signal: controller.signal })
    const sibling = runAskUser({ question: "sibling" })
    useAskUserStore.getState().resolveActive({ selected: [], text: "done", cancelled: false })
    await first
    controller.abort()
    expect(useAskUserStore.getState().active?.request.question).toBe("sibling")
    useAskUserStore
      .getState()
      .resolveActive({ selected: [], text: "sibling answer", cancelled: false })
    await expect(sibling).resolves.toContain("sibling answer")
  })

  it("cancels only the aborted child's queued question and leaves its sibling active", async () => {
    const active = runAskUser({ question: "sibling" }, { sessionId: "sibling" })
    const controller = new AbortController()
    const child = runAskUser(
      { question: "child" },
      { sessionId: "child", signal: controller.signal }
    )
    controller.abort()
    expect(useAskUserStore.getState().queue).toHaveLength(0)
    expect(useAskUserStore.getState().active?.sessionId).toBe("sibling")
    await expect(child).resolves.toMatch(/dismissed/)
    useAskUserStore.getState().resolveActive({ selected: [], text: "done", cancelled: false })
    await expect(active).resolves.toContain("done")
  })

  it("removes an active aborted question and promotes the next one", async () => {
    const controller = new AbortController()
    const child = runAskUser(
      { question: "child" },
      { sessionId: "child", signal: controller.signal }
    )
    const next = runAskUser({ question: "next" })
    controller.abort()
    expect(useAskUserStore.getState().active?.request.question).toBe("next")
    await expect(child).resolves.toMatch(/dismissed/)
    useAskUserStore
      .getState()
      .resolveActive({ selected: [], text: "next answer", cancelled: false })
    await expect(next).resolves.toContain("next answer")
  })

  it("does not enqueue a pre-cancelled question", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runAskUser({ question: "late" }, { signal: controller.signal })).resolves.toMatch(
      /dismissed/
    )
    expect(useAskUserStore.getState().active).toBeNull()
  })

  it("parses args, shows the prompt, and formats the resolved answer", async () => {
    const promise = runAskUser({
      question: "Pick a fruit",
      options: [
        { value: "a", label: "Apple" },
        { value: "b", label: "Banana" },
      ],
    })
    // The dialog is now active; simulate the user choosing Apple.
    expect(useAskUserStore.getState().active?.request.question).toBe("Pick a fruit")
    useAskUserStore.getState().resolveActive({ selected: ["a"], text: "", cancelled: false })
    await expect(promise).resolves.toContain("Apple")
  })

  it("returns a dismissal string when cancelled", async () => {
    const promise = runAskUser({ question: "anything" })
    useAskUserStore.getState().resolveActive({ selected: [], text: "", cancelled: true })
    await expect(promise).resolves.toMatch(/dismissed/)
  })
})
