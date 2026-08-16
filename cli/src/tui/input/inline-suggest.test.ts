/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useInlineSuggest, type UseInlineSuggestOptions } from "./inline-suggest"
import type { InlineCommandInfo } from "@/lib/chat/completion/inline/types"

/**
 * Let timers + provider promises settle inside `act`, so a late state update
 * (the debounced model tier landing after the assertion window) does not trip
 * React's "update not wrapped in act" warning.
 */
const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })

const COMMANDS: InlineCommandInfo[] = [
  { name: "compact", description: "Compact the transcript" },
  { name: "clear", description: "Clear the session" },
]

function render(over: Partial<UseInlineSuggestOptions> = {}) {
  const props: UseInlineSuggestOptions = {
    text: "",
    suppress: false,
    history: [],
    commands: COMMANDS,
    ...over,
  }
  return renderHook((p: UseInlineSuggestOptions) => useInlineSuggest(p), {
    initialProps: props,
  })
}

describe("useInlineSuggest — local tier", () => {
  it("completes from history", async () => {
    const { result } = render({ text: "fix ", history: ["fix the build"] })
    await waitFor(() => expect(result.current.ghost).toBe("the build"))
    expect(result.current.suggestion?.source).toBe("history")
  })

  it("treats the history ring as oldest-first so the newest entry wins", async () => {
    // `InputState.history.entries` is oldest → newest; the recency signal is
    // backwards if the hook forgets to reverse it.
    const { result } = render({ text: "fix ", history: ["fix oldest", "fix newest"] })
    await waitFor(() => expect(result.current.candidates.length).toBe(2))
    expect(result.current.ghost).toBe("newest")
  })

  it("completes a slash command name", async () => {
    const { result } = render({ text: "/comp" })
    await waitFor(() => expect(result.current.ghost).toBe("act"))
    expect(result.current.suggestion?.source).toBe("command")
  })

  it("resolves a command getter at query time, so late registrations are seen", async () => {
    // Project/user commands are discovered from disk and plugin commands
    // register with their plugin — both after the composer first renders. A
    // snapshot taken at mount froze the set for the whole session, so a user's
    // own command never appeared as ghost text while the `/` palette listed it.
    let registry: InlineCommandInfo[] = []
    const { result, rerender } = render({ text: "", commands: () => registry })
    registry = [{ name: "my-command", description: "A project command" }]
    rerender({ text: "/my-com", suppress: false, history: [], commands: () => registry })
    await waitFor(() => expect(result.current.ghost).toBe("mand"))
    expect(result.current.suggestion?.source).toBe("command")
  })

  it("suggests nothing while suppressed", async () => {
    const { result } = render({ text: "fix ", history: ["fix the build"], suppress: true })
    await settle(50)
    expect(result.current.ghost).toBe("")
  })

  it("never proposes a multi-line completion (the ghost shares the cursor row)", async () => {
    const { result } = render({ text: "fix ", history: ["fix the\nbuild"] })
    await settle(50)
    expect(result.current.ghost).toBe("")
  })

  it("suggests nothing when the local tier is off and no model is configured", async () => {
    const { result } = render({
      text: "fix ",
      history: ["fix the build"],
      localEnabled: false,
    })
    await settle(50)
    expect(result.current.ghost).toBe("")
  })

  it("accept returns the completed buffer text and clears the ghost", async () => {
    const { result } = render({ text: "fix ", history: ["fix the build"] })
    await waitFor(() => expect(result.current.ghost).toBe("the build"))
    let accepted: string | null = null
    act(() => {
      accepted = result.current.accept()
    })
    expect(accepted).toBe("fix the build")
    expect(result.current.ghost).toBe("")
  })

  it("accept returns null with nothing to accept", () => {
    const { result } = render({ text: "zzz" })
    expect(result.current.accept()).toBeNull()
  })

  it("cycles through candidates and back", async () => {
    const { result } = render({ text: "fix ", history: ["fix beta", "fix alpha"] })
    await waitFor(() => expect(result.current.candidates.length).toBe(2))
    expect(result.current.ghost).toBe("alpha")
    act(() => result.current.cycleNext())
    expect(result.current.ghost).toBe("beta")
    act(() => result.current.cyclePrev())
    expect(result.current.ghost).toBe("alpha")
  })

  it("dismiss clears the ghost", async () => {
    const { result } = render({ text: "fix ", history: ["fix the build"] })
    await waitFor(() => expect(result.current.ghost).toBe("the build"))
    act(() => result.current.dismiss())
    expect(result.current.ghost).toBe("")
  })

  it("re-suggests as the draft changes", async () => {
    const { result, rerender } = render({ text: "fix ", history: ["fix the build", "run tests"] })
    await waitFor(() => expect(result.current.ghost).toBe("the build"))
    rerender({
      text: "run ",
      suppress: false,
      history: ["fix the build", "run tests"],
      commands: COMMANDS,
    })
    await waitFor(() => expect(result.current.ghost).toBe("tests"))
  })
})

describe("useInlineSuggest — model tier", () => {
  it("adds a model continuation that outranks the history hit", async () => {
    const { result } = render({
      text: "fix ",
      history: ["fix the old way"],
      aiComplete: async () => "the build properly",
      debounceMs: 200,
    })
    // Local tier lands first, with no model round-trip.
    await waitFor(() => expect(result.current.ghost).toBe("the old way"))
    // Then the model upgrades it in place.
    await waitFor(() => expect(result.current.ghost).toBe("the build properly"))
    expect(result.current.suggestion?.source).toBe("ai")
    expect(result.current.candidates.length).toBe(2)
  })

  it("keeps the local suggestion when the model fails", async () => {
    const { result } = render({
      text: "fix ",
      history: ["fix the old way"],
      aiComplete: async () => {
        throw new Error("no provider")
      },
      debounceMs: 200,
    })
    await waitFor(() => expect(result.current.ghost).toBe("the old way"))
    await settle(300)
    expect(result.current.ghost).toBe("the old way")
  })

  it("works with the model tier alone when local completion is off", async () => {
    const { result } = render({
      text: "fix ",
      history: ["fix the old way"],
      localEnabled: false,
      aiComplete: async () => "it now",
      debounceMs: 200,
    })
    await waitFor(() => expect(result.current.ghost).toBe("it now"))
    expect(result.current.suggestion?.source).toBe("ai")
  })
})
