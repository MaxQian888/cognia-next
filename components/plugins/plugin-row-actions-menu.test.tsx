/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

import { PluginRowActionsMenu } from "./plugin-row-actions-menu"

const baseRow: PluginRow = {
  id: "p1",
  name: "Test Plugin",
  version: "1.0.0",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: ["tools"],
  path: "/plugins/test",
  manifest: { id: "p1" },
  createdAt: 1,
  updatedAt: 1,
}

function callbacks() {
  return {
    onOpen: jest.fn(),
    onConfigure: jest.fn(),
    onReviewPermissions: jest.fn(),
    onToggleEnabled: jest.fn(),
    onUninstall: jest.fn(),
  }
}

describe("PluginRowActionsMenu", () => {
  it("renders a trigger button with an aria-label including the plugin name", () => {
    const cb = callbacks()
    render(<PluginRowActionsMenu plugin={baseRow} {...cb} />)
    expect(screen.getByLabelText("actionsMenuAria:Test Plugin")).toBeInTheDocument()
  })

  // The audit drove this menu with a bare `click` (the agent-debug bridge's
  // `act … click`, which is also how assistive technology "presses" a button)
  // and it never opened: Radix's trigger answers only pointerdown / keydown.
  // The shared DropdownMenuTrigger now answers a click-only activation too.
  it("opens from a bare click with no hover or pointer gesture first", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={baseRow} {...cb} />)
    const trigger = screen.getByLabelText("actionsMenuAria:Test Plugin")

    // Reachable in the first place: a focusable button, never hidden or
    // pointer-gated until something hovers the row.
    expect(trigger.tagName).toBe("BUTTON")
    expect(trigger).not.toHaveClass("pointer-events-none", "invisible", "opacity-0")

    trigger.click()
    await user.click(await screen.findByRole("menuitem", { name: "openDetails" }))
    expect(cb.onOpen).toHaveBeenCalledWith("p1")
  })

  it("opens from the keyboard", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={baseRow} {...cb} />)
    screen.getByLabelText("actionsMenuAria:Test Plugin").focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("menuitem", { name: "openDetails" })).toBeInTheDocument()
  })

  it("invokes onOpen / onConfigure / onReviewPermissions / onUninstall after open", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={baseRow} {...cb} />)

    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    await user.click(await screen.findByText("openDetails"))
    expect(cb.onOpen).toHaveBeenCalledWith("p1")

    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    await user.click(await screen.findByText("configure"))
    expect(cb.onConfigure).toHaveBeenCalledWith("p1")

    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    await user.click(await screen.findByText("reviewPermissions"))
    expect(cb.onReviewPermissions).toHaveBeenCalledWith("p1")

    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    await user.click(await screen.findByText("uninstall"))
    expect(cb.onUninstall).toHaveBeenCalledWith(baseRow)
  })

  it("shows 'disable' when plugin.enabled is true", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={{ ...baseRow, enabled: true }} {...cb} />)
    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    expect(await screen.findByText("disable")).toBeInTheDocument()
  })

  it("shows 'enable' when plugin.enabled is false", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={{ ...baseRow, enabled: false }} {...cb} />)
    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    expect(await screen.findByText("enable")).toBeInTheDocument()
  })

  it("hides the Rollback item when onRollback is omitted", async () => {
    const cb = callbacks()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={baseRow} {...cb} />)
    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    await screen.findByText("openDetails")
    expect(screen.queryByText("rollback")).not.toBeInTheDocument()
  })

  it("shows the Rollback item and invokes onRollback when provided", async () => {
    const cb = callbacks()
    const onRollback = jest.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginRowActionsMenu plugin={baseRow} {...cb} onRollback={onRollback} />)
    await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
    await user.click(await screen.findByText("rollback"))
    expect(onRollback).toHaveBeenCalledWith("p1")
  })
})
