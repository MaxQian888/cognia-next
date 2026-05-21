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
