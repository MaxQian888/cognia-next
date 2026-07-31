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
