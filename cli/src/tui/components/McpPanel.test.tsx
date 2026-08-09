import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { McpPanel } from "./McpPanel"
import { absoluteTopLeft } from "../input/element-position"
import type { McpPanelServer } from "../runtime/mcp-panel-model"

jest.mock("../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}

const servers: McpPanelServer[] = [
  { name: "github", transport: "http", enabled: true, status: "connected", toolCount: 12 },
  { name: "brave", transport: "http", enabled: true, status: "needs_auth" },
  { name: "filesystem", transport: "stdio", enabled: false, status: "disabled" },
  { name: "broken", transport: "stdio", enabled: true, status: "failed", error: "ECONNREFUSED" },
]

function wrap(props: Partial<React.ComponentProps<typeof McpPanel>> = {}) {
  const cb = {
    onTools: jest.fn(),
    onAuth: jest.fn(),
    onReconnect: jest.fn(),
    onToggle: jest.fn(),
    onAdd: jest.fn(),
    onRemove: jest.fn(),
    onCancel: jest.fn(),
  }
  const result = render(<McpPanel servers={servers} probing={false} {...cb} {...props} />)
  return { ...result, ...cb }
}

describe("McpPanel", () => {
  beforeEach(() => {
    __resetInk()
    mockPos.mockReturnValue(null)
  })

  it("activates the clicked server row (header is 2 rows)", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onTools } = wrap()
    // border(1)+title(1)+filter(1) → first item at 0-based row 3 (SGR row 4) = github.
    key("[<0;5;4M")
    expect(onTools).toHaveBeenCalledWith("github")
  })

  it("moves the selection on the mouse wheel", () => {
    mockPos.mockReturnValue({ top: 0, left: 0 })
    const { onAuth } = wrap()
    key("[<65;5;5M") // wheel down → row 1 (brave, needs auth)
    key("", { return: true })
    expect(onAuth).toHaveBeenCalledWith("brave")
  })

  it("lists every server with its status hint", () => {
    const text = wrap().container.textContent ?? ""
    expect(text).toContain("MCP servers · 4")
    expect(text).toContain("github")
    expect(text).toContain("12 tools")
    expect(text).toContain("enter authorizes") // brave needs auth
    expect(text).toContain("enter reconnects") // broken failed
    expect(text).toContain("space enables") // filesystem (disabled)
  })

  it("shows a probing spinner while probing", () => {
    const text = wrap({ probing: true }).container.textContent ?? ""
    expect(text).toContain("probing")
  })

  it("Enter on a connected server opens its tool list", () => {
    const { onTools } = wrap()
    key("", { return: true }) // row 0 = github (connected)
    expect(onTools).toHaveBeenCalledWith("github")
  })

  it("Enter on a needs-auth server runs the auth flow", () => {
    const { onAuth } = wrap()
    key("", { downArrow: true }) // row 1 = brave
    key("", { return: true })
    expect(onAuth).toHaveBeenCalledWith("brave")
  })

  it("Enter on a failed server reconnects", () => {
    const { onReconnect } = wrap()
    for (let i = 0; i < 3; i++) key("", { downArrow: true }) // row 3 = broken
    key("", { return: true })
    expect(onReconnect).toHaveBeenCalledWith("broken")
  })

  it("shows complete diagnostic details for the selected failed server", () => {
    const { container } = wrap({
      servers: [
        {
          name: "context7",
          transport: "stdio",
          enabled: true,
          status: "failed",
          error: "MCP probe timed out after 12000ms\nError: CONTEXT7_API_KEY is missing",
        },
      ],
    })
    const text = container.textContent ?? ""
    expect(text).toContain("Connection issue · context7")
    expect(text).toContain("Timeout while connecting over stdio")
    expect(text).toContain("CONTEXT7_API_KEY is missing")
  })

  it("Enter on a disabled server enables it (toggle)", () => {
    const { onToggle } = wrap()
    for (let i = 0; i < 2; i++) key("", { downArrow: true }) // row 2 = filesystem (disabled)
    key("", { return: true })
    expect(onToggle).toHaveBeenCalledWith("filesystem")
  })

  it("Space toggles the highlighted server", () => {
    const { onToggle } = wrap()
    key(" ")
    expect(onToggle).toHaveBeenCalledWith("github")
  })

  it("Ctrl+N adds a server", () => {
    const { onAdd } = wrap()
    key("n", { ctrl: true })
    expect(onAdd).toHaveBeenCalled()
  })

  it("Ctrl+X removes the highlighted server", () => {
    const { onRemove } = wrap()
    key("x", { ctrl: true })
    expect(onRemove).toHaveBeenCalledWith("github")
  })

  it("does nothing on Enter for a pending (still-probing) row", () => {
    const cb = wrap({
      servers: [{ name: "slow", transport: "http", enabled: true, status: "pending" }],
    })
    key("", { return: true })
    expect(cb.onTools).not.toHaveBeenCalled()
    expect(cb.onAuth).not.toHaveBeenCalled()
    expect(cb.onReconnect).not.toHaveBeenCalled()
    expect(cb.onToggle).not.toHaveBeenCalled()
  })

  it("clamps the highlight at the top and shows scroll hints for a long list", () => {
    const many: McpPanelServer[] = Array.from({ length: 20 }, (_, i) => ({
      name: `srv${i}`,
      transport: "stdio",
      enabled: true,
      status: "connected",
    }))
    const cb = wrap({ servers: many, maxRows: 5 })
    key("", { upArrow: true }) // already at row 0 → clamped, no crash
    for (let i = 0; i < 8; i++) key("", { downArrow: true })
    expect(cb.container.textContent ?? "").toContain("more")
  })

  it("shows a no-matches hint when the filter excludes everything", () => {
    const { container } = wrap()
    for (const ch of "zzzz") key(ch)
    expect(container.textContent ?? "").toContain("no matches")
  })

  it("ignores Ctrl+X when the filter leaves no row selected", () => {
    const { onRemove } = wrap()
    for (const ch of "zzzz") key(ch)
    key("x", { ctrl: true })
    expect(onRemove).not.toHaveBeenCalled()
  })

  it("filters by typing and clears the filter on first Escape", () => {
    const { container, onCancel } = wrap()
    key("brav")
    expect(container.textContent ?? "").toContain("brave")
    expect(container.textContent ?? "").not.toContain("github")
    key("", { escape: true }) // first Esc clears the filter
    expect(onCancel).not.toHaveBeenCalled()
    expect(container.textContent ?? "").toContain("github")
    key("", { escape: true }) // second Esc closes
    expect(onCancel).toHaveBeenCalled()
  })
})
