import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { LogPanel } from "./LogPanel"
import { absoluteTopLeft } from "../input/element-position"
import type { LogEntry } from "../state/types"

jest.mock("../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

let seq = 0
function log(p: Partial<LogEntry>): LogEntry {
  seq += 1
  return {
    id: `l${seq}`,
    ts: p.ts ?? seq,
    level: p.level ?? "info",
    channel: p.channel ?? "agent",
    message: p.message ?? "",
    ...(p.origin ? { origin: p.origin } : {}),
  }
}

const entries: LogEntry[] = [
  log({ level: "error", channel: "mcp", origin: "github", message: "boom happened", ts: 1 }),
  log({ level: "info", channel: "agent", origin: "rev", message: "listing tools", ts: 2 }),
  log({ level: "warn", channel: "sidecar", message: "slow response", ts: 3 }),
  log({ level: "debug", channel: "system", message: "handshake done", ts: 4 }),
]

function wrap(props: Partial<React.ComponentProps<typeof LogPanel>> = {}) {
  const cb = {
    onClear: jest.fn(),
    onCopy: jest.fn(),
    onClose: jest.fn(),
    onInject: jest.fn<void, [LogEntry[], string]>(),
  }
  const result = render(<LogPanel entries={entries} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("LogPanel — rendering", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("renders the header count, level tallies, follow state, and every row", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("Logs · 4")
    expect(text).toContain("1 err")
    expect(text).toContain("1 warn")
    expect(text).toContain("following")
    expect(text).toContain("boom happened")
    expect(text).toContain("[mcp/github]")
    expect(text).toContain("[sidecar]")
  })

  it("renders per-channel chips", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("mcp 1")
    expect(text).toContain("agent 1")
  })

  it("shows the empty-state hint when nothing is captured", () => {
    const text = wrap({ entries: [] }).container.textContent ?? ""
    expect(text).toContain("no logs captured yet")
  })

  it("renders both footer rows", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("Tab level")
    expect(text).toContain("^A inject all")
  })
})

describe("LogPanel — search and filters", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("filters as you type, matching message and origin", () => {
    const r = wrap()
    key("boom")
    expect(r.container.textContent).toContain("boom happened")
    expect(r.container.textContent).not.toContain("listing tools")
  })

  it("matches on origin too", () => {
    const r = wrap()
    key("rev")
    expect(r.container.textContent).toContain("listing tools")
    expect(r.container.textContent).not.toContain("boom happened")
  })

  it("backspace restores the filtered set", () => {
    const r = wrap()
    key("boom")
    for (let i = 0; i < 4; i++) key("", { backspace: true })
    expect(r.container.textContent).toContain("listing tools")
  })

  it("shows a no-matches hint when the query excludes everything", () => {
    const r = wrap()
    key("zzzz")
    expect(r.container.textContent).toContain("no matches")
  })

  it("Tab cycles the level filter", () => {
    const r = wrap()
    key("", { tab: true })
    expect(r.container.textContent).toContain("level:error")
    expect(r.container.textContent).not.toContain("listing tools")
  })

  it("⇧Tab cycles the channel filter over present channels only", () => {
    const r = wrap()
    key("", { tab: true, shift: true })
    expect(r.container.textContent).toContain("channel:mcp")
    expect(r.container.textContent).not.toContain("listing tools")
  })

  it("Esc clears the query first, then closes", () => {
    const r = wrap()
    key("boom")
    key("", { escape: true })
    expect(r.onClose).not.toHaveBeenCalled()
    expect(r.container.textContent).toContain("listing tools")
    key("", { escape: true })
    expect(r.onClose).toHaveBeenCalled()
  })
})

describe("LogPanel — scrolling", () => {
  const many: LogEntry[] = Array.from({ length: 30 }, (_, i) => log({ message: `row-${i}`, ts: i }))

  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("honours the log panel's own row budget, not the raw maxRows", () => {
    // maxRows 8 − LOG_PANEL_EXTRA_ROWS(3) = 5 item rows.
    const r = wrap({ entries: many, maxRows: 8 })
    const text = r.container.textContent ?? ""
    expect(text).toContain("row-29")
    expect(text).toContain("row-25")
    expect(text).not.toContain("row-24")
  })

  it("↑ drops follow and ↓ back to the newest re-engages it", () => {
    const r = wrap({ entries: many, maxRows: 8 })
    key("", { upArrow: true })
    expect(r.container.textContent).not.toContain("following")
    key("", { downArrow: true })
    expect(r.container.textContent).toContain("following")
  })

  it("PgUp pages by the item budget", () => {
    const r = wrap({ entries: many, maxRows: 8 })
    key("", { pageUp: true })
    const text = r.container.textContent ?? ""
    expect(text).not.toContain("following")
    expect(text).toContain("row-24")
  })

  it("PgDn returns to the newest rows", () => {
    const r = wrap({ entries: many, maxRows: 8 })
    key("", { pageUp: true })
    key("", { pageDown: true })
    expect(r.container.textContent).toContain("row-29")
  })

  it("^F toggles follow off and back on", () => {
    const r = wrap({ entries: many, maxRows: 8 })
    key("f", { ctrl: true })
    expect(r.container.textContent).not.toContain("following")
    key("f", { ctrl: true })
    expect(r.container.textContent).toContain("following")
  })

  it("the wheel scrolls and drops follow", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const r = wrap({ entries: many, maxRows: 8 })
    key("\x1b[<64;5;5M")
    expect(r.container.textContent).not.toContain("following")
  })
})

describe("LogPanel — clear and copy", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("^L clears and re-engages follow", () => {
    const r = wrap()
    key("l", { ctrl: true })
    expect(r.onClear).toHaveBeenCalled()
  })

  it("^Y copies only the filtered rows", () => {
    const r = wrap()
    key("boom")
    key("y", { ctrl: true })
    const copied = r.onCopy.mock.calls[0][0] as string
    expect(copied).toContain("boom happened")
    expect(copied).not.toContain("listing tools")
  })
})

describe("LogPanel — injection", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("Enter injects exactly the selected row, with the filter scope", () => {
    const r = wrap()
    key("", { return: true })
    expect(r.onInject).toHaveBeenCalledTimes(1)
    const [rows, scope] = r.onInject.mock.calls[0]
    // follow is on, so the selection is the newest row.
    expect(rows).toHaveLength(1)
    expect(rows[0].message).toBe("handshake done")
    expect(scope).toContain("4/4")
  })

  it("Enter does NOT leak a carriage return into the query", () => {
    // The bug McpLogPanel still has: without an explicit key.return branch the
    // printable fallback appends "\r" to the filter.
    const r = wrap()
    key("", { return: true })
    expect(r.container.textContent).toContain("listing tools")
    expect(r.container.textContent).not.toContain("no matches")
  })

  it("^A injects the whole filtered set, excluding filtered-out rows", () => {
    const r = wrap()
    key("oo") // matches "boom happened" + "listing tools", not "handshake done"
    key("a", { ctrl: true })
    const [rows] = r.onInject.mock.calls[0]
    expect(rows.map((e) => e.message)).not.toContain("handshake done")
    expect(rows.length).toBeGreaterThan(1)
  })

  it("does not inject when the filtered set is empty", () => {
    const r = wrap()
    key("zzzz")
    key("", { return: true })
    key("a", { ctrl: true })
    expect(r.onInject).not.toHaveBeenCalled()
  })
})

describe("LogPanel — mouse selection", () => {
  const many: LogEntry[] = Array.from({ length: 30 }, (_, i) => log({ message: `row-${i}`, ts: i }))

  beforeEach(() => {
    __resetInk()
  })

  it("a click selects the clicked row rather than injecting it", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const r = wrap({ entries: many, maxRows: 8 })
    key("\x1b[<0;5;4M")
    expect(r.onInject).not.toHaveBeenCalled()
  })

  it("maps a click past the chips row onto a real item row", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const r = wrap({ entries: many, maxRows: 8 })
    // headerRows must be 3 (title + chips + filter). A copied-from-McpLogPanel
    // value of 2 would mis-map every click by one row.
    key("\x1b[<0;5;6M")
    expect(r.onInject).not.toHaveBeenCalled()
    expect(r.container.textContent).not.toContain("following")
  })
})
