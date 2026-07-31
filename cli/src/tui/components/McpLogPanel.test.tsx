import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { McpLogPanel } from "./McpLogPanel"
import { absoluteTopLeft } from "../input/element-position"
import type { McpLogEntry } from "../state/types"

jest.mock("../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

let seq = 0
function log(p: Partial<McpLogEntry>): McpLogEntry {
  seq += 1
  return {
    id: `c${seq}`,
    ts: p.ts ?? 0,
    level: p.level ?? "info",
    source: p.source ?? "stderr",
    message: p.message ?? "",
    ...(p.server ? { server: p.server } : {}),
  }
}

const logs: McpLogEntry[] = [
  log({ level: "error", server: "github", message: "boom happened", ts: 1 }),
  log({ level: "info", server: "filesystem", message: "listing tools", ts: 2 }),
  log({ level: "warn", server: "github", message: "slow response", ts: 3 }),
  log({ level: "debug", message: "handshake done", ts: 4 }),
]

function wrap(props: Partial<React.ComponentProps<typeof McpLogPanel>> = {}) {
  const cb = { onClear: jest.fn(), onCopy: jest.fn(), onClose: jest.fn() }
  const result = render(<McpLogPanel logs={logs} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("McpLogPanel", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("renders the header count, level tallies, and every captured line", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("MCP logs · 4")
    expect(text).toContain("1 err")
    expect(text).toContain("1 warn")
    expect(text).toContain("following") // follow is on by default
    expect(text).toContain("boom happened")
    expect(text).toContain("[github]")
    expect(text).toContain("listing tools")
  })

  it("shows the empty-state hint when no logs are captured", () => {
    const text = wrap({ logs: [] }).container.textContent ?? ""
    expect(text).toContain("no MCP logs captured yet")
  })

  it("filters by typing a substring over message + server, and backspace edits it", () => {
    const { container } = wrap()
    key("slow")
    expect(container.textContent ?? "").toContain("slow response")
    expect(container.textContent ?? "").not.toContain("boom happened")
    // Backspace the whole term → the filter clears and every line returns.
    for (let i = 0; i < 4; i++) key("", { backspace: true })
    expect(container.textContent ?? "").toContain("boom happened")
  })

  it("scrolls on the mouse wheel (dropping follow)", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const many: McpLogEntry[] = Array.from({ length: 30 }, (_, i) =>
      log({ level: "info", message: `line ${i}`, ts: i })
    )
    const { container } = wrap({ logs: many, maxRows: 5 })
    key("[<65;5;6M") // wheel down
    key("[<64;5;6M") // wheel up → scroll off the newest row, dropping follow
    expect(container.textContent ?? "").not.toContain("following")
  })

  it("shows a no-matches hint when the filter excludes everything", () => {
    const { container } = wrap()
    for (const ch of "zzzz") key(ch)
    expect(container.textContent ?? "").toContain("no matches")
  })

  it("Tab cycles the level filter (all → error)", () => {
    const { container } = wrap()
    key("", { tab: true }) // level → error
    const text = container.textContent ?? ""
    expect(text).toContain("boom happened") // the only error line
    expect(text).not.toContain("slow response") // warn excluded
    expect(text).toContain("level:error")
  })

  it("Shift+Tab cycles the server filter (all → filesystem)", () => {
    const { container } = wrap()
    key("", { tab: true, shift: true }) // server → filesystem (first alphabetically)
    const text = container.textContent ?? ""
    expect(text).toContain("listing tools")
    expect(text).not.toContain("boom happened")
    expect(text).toContain("server:filesystem")
  })

  it("Ctrl+L clears the buffer", () => {
    const { onClear } = wrap()
    key("l", { ctrl: true })
    expect(onClear).toHaveBeenCalled()
  })

  it("Ctrl+Y copies the visible (filtered) lines", () => {
    const { onCopy } = wrap()
    key("boom") // filter to the one error line
    key("y", { ctrl: true })
    expect(onCopy).toHaveBeenCalledTimes(1)
    const copied = onCopy.mock.calls[0][0] as string
    expect(copied).toContain("boom happened")
    expect(copied).not.toContain("listing tools")
  })

  it("Ctrl+F toggles follow off, then back on (re-engaging snaps to newest)", () => {
    const { container } = wrap()
    expect(container.textContent ?? "").toContain("following")
    key("f", { ctrl: true })
    expect(container.textContent ?? "").not.toContain("following")
    key("f", { ctrl: true }) // re-engage
    expect(container.textContent ?? "").toContain("following")
  })

  it("arrow-up scrolls and drops follow; scrolling back to the newest re-engages it", () => {
    const { container } = wrap()
    key("", { upArrow: true })
    expect(container.textContent ?? "").not.toContain("following")
    key("", { downArrow: true }) // back to the newest row
    expect(container.textContent ?? "").toContain("following")
  })

  it("clears the filter on the first Escape, then closes on the second", () => {
    const { container, onClose } = wrap()
    key("boom")
    expect(container.textContent ?? "").not.toContain("listing tools")
    key("", { escape: true }) // first Esc clears the filter
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent ?? "").toContain("listing tools")
    key("", { escape: true }) // second Esc closes
    expect(onClose).toHaveBeenCalled()
  })

  it("renders an optional live status summary line", () => {
    const text = wrap({ statusSummary: "github ✓ · filesystem ✗" }).container.textContent ?? ""
    expect(text).toContain("github ✓ · filesystem ✗")
  })

  it("shows scroll hints for a buffer taller than maxRows", () => {
    const many: McpLogEntry[] = Array.from({ length: 30 }, (_, i) =>
      log({ level: "info", message: `line ${i}`, ts: i })
    )
    const { container } = wrap({ logs: many, maxRows: 5 })
    // Follow pins to the newest → the "↑ more" hint is present.
    expect(container.textContent ?? "").toContain("↑")
    // Scroll to the very top to reveal the "↓ more" (below) hint.
    for (let i = 0; i < 40; i++) key("", { upArrow: true })
    expect(container.textContent ?? "").toContain("↓")
  })
})
