import React from "react"
import { act, render } from "@testing-library/react"

import { Inflight } from "./Inflight"
import { hasSpinnerFrame } from "./Spinner"
import { ThemeProvider } from "../theme/context"
import { BUILTIN_THEMES } from "../theme/builtins"

const wrap = (el: React.ReactElement) =>
  render(<ThemeProvider palette={BUILTIN_THEMES.ansi}>{el}</ThemeProvider>)

const empty = { thinking: "", text: "", tools: [] }

describe("Inflight", () => {
  it("collapses reasoning by default — indicator + expand hint, no body", () => {
    const { container } = wrap(
      <Inflight inflight={{ ...empty, thinking: "pondering", text: "**answer**" }} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("✻ Thinking…")
    expect(text).toContain("ctrl+o to expand")
    // The reasoning body stays hidden until detail mode.
    expect(text).not.toContain("pondering")
    expect(text).toContain("answer")
  })

  it("shows the full reasoning stream in verbose mode", () => {
    const { container } = wrap(
      <Inflight inflight={{ ...empty, thinking: "pondering", text: "" }} verbose />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("✻ Thinking…")
    expect(text).toContain("pondering")
    // No expand hint when already expanded.
    expect(text).not.toContain("ctrl+o")
  })

  it("renders only text when there is no reasoning", () => {
    const { container } = wrap(<Inflight inflight={{ ...empty, thinking: "", text: "hi" }} />)
    expect(container.textContent).toContain("hi")
  })

  it("renders nothing when idle", () => {
    const { container } = wrap(<Inflight inflight={{ ...empty, thinking: "", text: "" }} />)
    expect(container.textContent).toBe("")
  })

  it("renders running tool cells live with an animated spinner", () => {
    const { container } = wrap(
      <Inflight
        inflight={{
          ...empty,
          tools: [
            {
              id: "t1",
              kind: "tool",
              callKey: "k",
              toolName: "bash",
              input: { command: "ls" },
              status: "running",
              collapsed: true,
            },
          ],
        }}
      />
    )
    // A running tool now shows a spinner glyph instead of the static ⏳.
    expect(hasSpinnerFrame(container.textContent ?? "")).toBe(true)
    expect(container.textContent).toContain("Bash")
  })

  // The live region is where a read-heavy turn floods the screen: the
  // transcript has always folded a settled context burst, but only after the
  // turn committed, so twelve cards sat on screen for the whole time the reader
  // was trying to follow along.
  it("folds a settled run of context reads into one summary row", () => {
    const tool = (id: string, path: string) => ({
      id,
      kind: "tool" as const,
      callKey: id,
      toolName: "read",
      input: { path },
      status: "done" as const,
      collapsed: true,
      result: "ok",
    })
    const { container } = wrap(
      <Inflight
        inflight={{ ...empty, tools: [tool("t1", "a.ts"), tool("t2", "b.ts"), tool("t3", "c.ts")] }}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("⚙")
    expect(text).toContain("Read: a.ts")
    expect(text).toContain("Read: b.ts")
    expect(text).toContain("done")
  })

  it("keeps every read visible in verbose mode", () => {
    const tool = (id: string, path: string) => ({
      id,
      kind: "tool" as const,
      callKey: id,
      toolName: "read",
      input: { path },
      status: "done" as const,
      collapsed: true,
      result: "ok",
    })
    const { container } = wrap(
      <Inflight inflight={{ ...empty, tools: [tool("t1", "a.ts"), tool("t2", "b.ts")] }} verbose />
    )
    expect(container.textContent ?? "").toContain("a.ts")
    expect(container.textContent ?? "").toContain("ok")
  })

  it("re-renders tool cells when they complete", () => {
    const { container, rerender } = wrap(
      <Inflight
        inflight={{
          ...empty,
          tools: [
            {
              id: "t1",
              kind: "tool",
              callKey: "k",
              toolName: "read",
              input: { path: "x" },
              status: "running",
              collapsed: true,
            },
          ],
        }}
      />
    )
    expect(hasSpinnerFrame(container.textContent ?? "")).toBe(true)
    // Tool result arrives — status switches to done.
    rerender(
      <ThemeProvider palette={BUILTIN_THEMES.ansi}>
        <Inflight
          inflight={{
            ...empty,
            tools: [
              {
                id: "t1",
                kind: "tool",
                callKey: "k",
                toolName: "read",
                input: { path: "x" },
                status: "done",
                result: "contents",
                collapsed: true,
              },
            ],
          }}
        />
      </ThemeProvider>
    )
    expect(container.textContent).toContain("✓")
    // The spinner is gone once the tool completes.
    expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
  })
})

it.each([false, true])(
  "shows queued=%s tools as waiting for approval until the overlay closes",
  (queued) => {
    jest.useFakeTimers()
    try {
      const tool = {
        id: "approval",
        kind: "tool" as const,
        callKey: "approval",
        toolName: "bash",
        input: { command: "touch approved.txt" },
        status: "running" as const,
        collapsed: true,
      }
      const props = {
        inflight: { ...empty, tools: queued ? [] : [tool] },
        pending: queued ? [tool] : [],
      }
      const { container, rerender } = wrap(<Inflight {...props} awaitingApproval />)
      expect(container.textContent).toContain("Waiting for approval")
      expect(container.textContent).toContain("Bash")
      expect(container.textContent).toContain("touch approved.txt")
      act(() => jest.advanceTimersByTime(5000))
      expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
      expect(container.textContent).not.toContain("5s")
      expect(tool.status).toBe("running")
      rerender(
        <ThemeProvider palette={BUILTIN_THEMES.ansi}>
          <Inflight {...props} awaitingApproval={false} />
        </ThemeProvider>
      )
      expect(container.textContent).not.toContain("Waiting for approval")
      expect(hasSpinnerFrame(container.textContent ?? "")).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  }
)

it("pauses the thinking indicator during approval and preserves completed tools", () => {
  const { container } = wrap(
    <Inflight
      awaitingApproval
      inflight={{
        ...empty,
        thinking: "earlier reasoning",
        tools: [
          {
            id: "done",
            kind: "tool",
            callKey: "done",
            toolName: "bash",
            input: { command: "ls" },
            status: "done",
            result: "ok",
            collapsed: true,
          },
        ],
      }}
    />
  )
  expect(container.textContent).toContain("Waiting for approval")
  expect(container.textContent).not.toContain("Thinking…")
  expect(container.textContent).toContain("✓")
  expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
})
