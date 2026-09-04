import React from "react"
import { render } from "@testing-library/react"

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
    expect(text).not.toContain("a.ts")
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
