import React from "react"
import { render, waitFor } from "@testing-library/react"

import { VirtualizedTranscript } from "./VirtualizedTranscript"
import { RenderPrefsProvider } from "../render/context"
import { RENDER_DEFAULTS } from "../../config/schema"
import type { Cell } from "../state/types"

describe("VirtualizedTranscript", () => {
  it("renders only the visible window plus overscan", () => {
    const cells: Cell[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `c${index}`,
      kind: "notice" as const,
      message: `message-${index}`,
    }))
    // One notice is one row now that adjacent rows pack together, so the
    // scroll offset is the cell index. It used to be two, and this offset was
    // written as 1000 to reach the same cell.
    const { container } = render(
      <VirtualizedTranscript cells={cells} width={80} top={500} viewportRows={20} verbose={false} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("message-500")
    expect(text).not.toContain("message-0")
    expect(text).not.toContain("message-999")
    // The window is the viewport plus two overscans of it, so at one row per
    // notice that is the block count too. The point is that it is a window and
    // not the thousand cells behind it.
    expect(container.querySelectorAll('[data-testid="terminal-block"]').length).toBeLessThanOrEqual(
      5 * 20
    )
  })

  // Density. A working turn is mostly one-line rows, and a blank after every
  // one of them halved how much of the conversation a terminal could hold.
  it("packs adjacent one-line cells and keeps a paragraph separated", () => {
    const cells: Cell[] = [
      { id: "u", kind: "user", text: "do the thing" },
      { id: "t1", kind: "tool", callKey: "k1", toolName: "read", input: {}, status: "done" },
      { id: "n1", kind: "notice", message: "first notice" },
      { id: "n2", kind: "notice", message: "second notice" },
      { id: "a", kind: "assistant", raw: "the answer" },
    ]
    const { container } = render(
      <VirtualizedTranscript cells={cells} width={80} top={0} viewportRows={40} verbose />
    )
    // One element per block, each holding one element per rendered row.
    const rowsPerBlock = [...container.querySelectorAll('[data-testid="terminal-block"]')].map(
      (block) => block.children.length
    )
    // user, tool, notice, notice, assistant.
    expect(rowsPerBlock).toHaveLength(5)
    // A question is separated from the work under it.
    expect(rowsPerBlock[0]).toBe(2)
    // The tool card and the first notice pack against what follows them. The
    // second notice keeps its blank, because a reply comes next.
    expect(rowsPerBlock.slice(1, 4)).toEqual([1, 1, 2])
    // The reply gets its air back, and the transcript ends with a blank so it
    // never butts up against the composer.
    expect(rowsPerBlock[4]).toBe(2)
  })

  it("renders all rows before the viewport has been measured", () => {
    const cells: Cell[] = [
      { id: "a", kind: "notice", message: "first" },
      { id: "b", kind: "notice", message: "second" },
    ]
    const { container } = render(
      <VirtualizedTranscript cells={cells} width={40} top={0} viewportRows={0} verbose={false} />
    )
    expect(container.textContent).toContain("first")
    expect(container.textContent).toContain("second")
  })

  it("folds a settled context burst into one summary row", () => {
    const tool = (id: string, toolName: string): Cell => ({
      id,
      kind: "tool",
      callKey: id,
      toolName,
      input: { file_path: `/${id}.ts` },
      status: "done",
      result: "contents",
      collapsed: true,
    })
    const { container } = render(
      <VirtualizedTranscript
        cells={[tool("a", "read"), tool("b", "read"), tool("c", "grep")]}
        width={80}
        top={0}
        viewportRows={20}
        verbose={false}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("⚙ 2 reads, 1 search")
    expect(text).not.toContain("/a.ts")
    expect(container.querySelectorAll('[data-testid="terminal-block"]').length).toBe(1)
  })

  it("keeps every context call visible in verbose mode", () => {
    const tool = (id: string): Cell => ({
      id,
      kind: "tool",
      callKey: id,
      toolName: "read",
      input: { file_path: `/${id}.ts` },
      status: "done",
      result: "contents",
      collapsed: true,
    })
    const { container } = render(
      <VirtualizedTranscript
        cells={[tool("a"), tool("b")]}
        width={80}
        top={0}
        viewportRows={40}
        verbose
      />
    )
    expect(container.textContent).toContain("/a.ts")
    expect(container.textContent).toContain("/b.ts")
  })

  it("paints a tool header with one span per styled run", () => {
    const { container } = render(
      <VirtualizedTranscript
        cells={[
          {
            id: "t",
            kind: "tool",
            callKey: "t",
            toolName: "bash",
            input: { command: "pnpm test" },
            status: "error",
            isError: true,
            result: "boom",
            collapsed: true,
          },
        ]}
        width={80}
        top={0}
        viewportRows={20}
        verbose={false}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("✗")
    expect(text).toContain("» Bash pnpm test")
    expect(text).toContain("↳ boom")
  })

  it("applies the transcript render preferences to a committed cell", () => {
    const cell: Cell = {
      id: "r",
      kind: "tool",
      callKey: "r",
      toolName: "read",
      input: { file_path: "demo.ts" },
      status: "done",
      collapsed: false,
      result: Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"),
    }
    const { container } = render(
      <RenderPrefsProvider prefs={{ ...RENDER_DEFAULTS, toolResultMaxLines: 2 }}>
        <VirtualizedTranscript
          cells={[cell]}
          width={80}
          top={0}
          viewportRows={40}
          verbose={false}
        />
      </RenderPrefsProvider>
    )
    const text = container.textContent ?? ""
    // The preferences used to stop at the Ink card path, so this renderer showed
    // every line, un-numbered, however the settings panel was set.
    expect(text).toContain("1 │ line 1")
    expect(text).toContain("+6 more lines hidden")
    expect(text).not.toContain("line 8")
  })

  it("reserves the terminal auto-wrap column so the next row keeps its first character", async () => {
    const onMetrics = jest.fn()
    render(
      <VirtualizedTranscript
        cells={[{ id: "a", kind: "assistant", raw: "A".repeat(40) }]}
        width={40}
        top={0}
        viewportRows={10}
        verbose={false}
        onMetrics={onMetrics}
      />
    )
    await waitFor(() => expect(onMetrics).toHaveBeenCalled())
    expect(onMetrics.mock.calls.at(-1)?.[0]).toEqual([{ id: "a", rows: 3 }])
  })
})
