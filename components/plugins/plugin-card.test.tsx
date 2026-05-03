/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

import { PluginCard } from "./plugin-card"

const baseRow: PluginRow = {
  id: "plugin_test",
  name: "Test Plugin",
  version: "1.2.3",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: ["tools", "commands", "themes", "hooks", "exporters"],
  path: "/plugins/test",
  manifest: {
    id: "plugin_test",
    permissions: ["clipboard:read", "filesystem:write"],
    signature: { verified: true },
  },
  createdAt: 1,
  updatedAt: 1,
}

const callbacks = () => ({
  onToggleSelect: jest.fn(),
  onOpen: jest.fn(),
  onConfigure: jest.fn(),
  onToggleEnabled: jest.fn(),
  onUninstall: jest.fn(),
  onReviewPermissions: jest.fn(),
})

describe("PluginCard", () => {
  it("renders core metadata", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    expect(screen.getByText("Test Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
    expect(screen.getByText("plugin_test")).toBeInTheDocument()
  })

  it("renders capability chips with overflow indicator beyond 4", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    expect(screen.getByText("tools")).toBeInTheDocument()
    expect(screen.getByText("commands")).toBeInTheDocument()
    // 5 caps total, 4 shown + "+1"
    expect(screen.getByText("+1")).toBeInTheDocument()
  })

  it("renders permission count badge", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    expect(screen.getByText("permissionCount:2")).toBeInTheDocument()
  })

  it("clicking the title invokes onOpen", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    fireEvent.click(screen.getByText("Test Plugin"))
    expect(cb.onOpen).toHaveBeenCalledWith("plugin_test")
  })

  it("toggling the checkbox invokes onToggleSelect", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    fireEvent.click(screen.getByLabelText(/Select Test Plugin/))
    expect(cb.onToggleSelect).toHaveBeenCalledWith("plugin_test")
  })

  it("renders error pill and message when status=error", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{ ...baseRow, status: "error", error: "load failed" }}
        selected={false}
        {...cb}
      />
    )
    // The mocked translator returns the key unnamespaced; the pill scoped on
    // "plugins.card.status" so t("error") → "error".
    expect(screen.getAllByText("error").length).toBeGreaterThan(0)
    expect(screen.getByText("load failed")).toBeInTheDocument()
  })

  it("renders disabled status when enabled=false and not errored", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{ ...baseRow, enabled: false, status: "disabled" }}
        selected={false}
        {...cb}
      />
    )
    expect(screen.getAllByText("disabled").length).toBeGreaterThan(0)
  })

  it("renders update-available badge when manifest flags it", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{
          ...baseRow,
          manifest: { ...baseRow.manifest, updateAvailable: true },
        }}
        selected={false}
        {...cb}
      />
    )
    expect(screen.getByText("updateBadge")).toBeInTheDocument()
  })

  it("renders a Rollback menu item when onRollback is provided", async () => {
    const cb = callbacks()
    const onRollback = jest.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginCard plugin={baseRow} selected={false} onRollback={onRollback} {...cb} />)
    const triggers = screen.getAllByRole("button")
    const menuTrigger = triggers.find((b) => b.getAttribute("aria-haspopup") === "menu")
    expect(menuTrigger).toBeDefined()
    await user.click(menuTrigger!)
    await user.click(await screen.findByText("rollback"))
    expect(onRollback).toHaveBeenCalledWith("plugin_test")
  })

  it("hides the Rollback menu item when onRollback is omitted", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    const triggers = screen.getAllByRole("button")
    const menuTrigger = triggers.find((b) => b.getAttribute("aria-haspopup") === "menu")
    await user.click(menuTrigger!)
    expect(screen.queryByText("rollback")).not.toBeInTheDocument()
  })
})
