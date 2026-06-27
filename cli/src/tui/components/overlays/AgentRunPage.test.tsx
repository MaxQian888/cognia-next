import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { AgentRunPage } from "./AgentRunPage"
import type { SubagentLiveEntry } from "../../../agent/subagent-live-output"

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const NOW = 100_000

function entry(over: Partial<SubagentLiveEntry> = {}): SubagentLiveEntry {
  return {
    liveId: "live-1",
    name: "reviewer",
    task: "review the diff",
    sessionId: "s1",
    status: "running",
    startedAt: NOW - 8_000,
    text: "",
    thinking: "",
    tools: [],
    version: 0,
    ...over,
  }
}

function wrap(props: Partial<React.ComponentProps<typeof AgentRunPage>> = {}) {
  const onClose = jest.fn()
  const result = render(
    <AgentRunPage
      liveId="live-1"
      name="reviewer"
      task="review the diff"
      now={NOW}
      viewportRows={20}
      getEntry={() => entry()}
      onClose={onClose}
      {...props}
    />
  )
  return { ...result, onClose }
}

describe("AgentRunPage", () => {
  beforeEach(() => __resetInk())
  afterEach(() => jest.useRealTimers())

  it("renders the header with name, status, and elapsed", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("reviewer")
    expect(text).toContain("running")
    expect(text).toContain("8s")
    expect(text).toContain("review the diff")
  })

  it("shows the waiting state before any output", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("waiting for first output")
  })

  it("renders thinking, tools, and reply text once present", () => {
    const text =
      wrap({
        getEntry: () =>
          entry({
            thinking: "let me think",
            tools: [
              { id: "a", name: "read", status: "done" },
              { name: "bash", status: "running" },
            ],
            text: "here is the answer",
          }),
      }).container.textContent ?? ""
    expect(text).toContain("Thinking")
    expect(text).toContain("let me think")
    expect(text).toContain("Tools")
    expect(text).toContain("read")
    expect(text).toContain("bash")
    expect(text).toContain("here is the answer")
  })

  it("shows a no-output message when the entry is missing (cross-session / evicted)", () => {
    const text = wrap({ getEntry: () => undefined }).container.textContent ?? ""
    expect(text).toContain("no live output for this run")
  })

  it("uses settledAt for elapsed once the run has settled", () => {
    const text =
      wrap({
        getEntry: () => entry({ status: "done", startedAt: NOW - 30_000, settledAt: NOW - 18_000 }),
      }).container.textContent ?? ""
    expect(text).toContain("done")
    expect(text).toContain("12s")
  })

  it("closes on Esc and Enter", () => {
    const a = wrap()
    key("", { escape: true })
    expect(a.onClose).toHaveBeenCalledTimes(1)
    const b = wrap()
    key("", { return: true })
    expect(b.onClose).toHaveBeenCalledTimes(1)
  })

  it("re-reads the live store on the poll interval while running", () => {
    jest.useFakeTimers()
    const live = entry({ text: "first" })
    const onClose = jest.fn()
    const { container } = render(
      <AgentRunPage
        liveId="live-1"
        name="reviewer"
        task="t"
        now={NOW}
        viewportRows={20}
        pollMs={100}
        getEntry={() => live}
        onClose={onClose}
      />
    )
    expect(container.textContent).toContain("first")
    // Mutate the live entry as a stream would, then let the poll tick fire.
    live.text = "first second"
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(container.textContent).toContain("first second")
  })

  it("falls back to the terminal-derived viewport when none is provided", () => {
    const onClose = jest.fn()
    const { container } = render(
      <AgentRunPage
        liveId="live-1"
        name="reviewer"
        task="t"
        now={NOW}
        getEntry={() => entry({ text: "hi" })}
        onClose={onClose}
      />
    )
    expect(container.textContent).toContain("reviewer")
  })

  it("scrolls the body on wheel and arrow keys without closing", () => {
    const onClose = jest.fn()
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    const a = render(
      <AgentRunPage
        liveId="live-1"
        name="reviewer"
        task="t"
        now={NOW}
        viewportRows={5}
        getEntry={() => entry({ text: body })}
        onClose={onClose}
      />
    )
    key("[<65;5;5M") // wheel down
    key("[<64;5;5M") // wheel up
    key("", { downArrow: true }) // arrow scroll
    expect(onClose).not.toHaveBeenCalled()
    a.unmount()
  })

  it("stops polling once the run has settled", () => {
    jest.useFakeTimers()
    const setInterval = jest.spyOn(global, "setInterval")
    wrap({ getEntry: () => entry({ status: "done", settledAt: NOW }) })
    expect(setInterval).not.toHaveBeenCalled()
    setInterval.mockRestore()
  })
})
