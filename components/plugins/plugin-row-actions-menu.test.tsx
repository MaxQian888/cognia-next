/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

const mockRollbackAvailable = jest.fn(() => true)
jest.mock("@/hooks/plugins/use-plugin-rollback-availability", () => ({
  usePluginRollbackAvailable: () => mockRollbackAvailable(),
}))
const mockProfile = jest.fn(() => "tauri")
jest.mock("@/hooks/plugins/use-plugin-runtime-profile", () => ({
  usePluginRuntimeProfile: () => mockProfile(),
}))
const mockMirrored = jest.fn(() => false)
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  isMirroredPluginClient: () => mockMirrored(),
}))

import { PluginRowActionsMenu } from "./plugin-row-actions-menu"

beforeEach(() => {
  mockRollbackAvailable.mockReturnValue(true)
  mockProfile.mockReturnValue("tauri")
  mockMirrored.mockReturnValue(false)
})

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
  manifest: {
    id: "p1",
    configSchema: { type: "object", properties: { apiKey: { type: "string" } } },
    permissions: ["network:fetch"],
  } as never,
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

  describe("gates", () => {
    async function openMenu(plugin: PluginRow) {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      render(<PluginRowActionsMenu plugin={plugin} {...callbacks()} onRollback={jest.fn()} />)
      await user.click(screen.getByLabelText(`actionsMenuAria:${plugin.name}`))
    }

    // Rollback used to be offered everywhere and open an empty list.
    it("hides Rollback when there is nothing to roll back to", async () => {
      mockRollbackAvailable.mockReturnValue(false)
      await openMenu(baseRow)
      expect(screen.queryByText("rollback")).not.toBeInTheDocument()
    })

    it("disables Enable for a plugin this host cannot run and says why", async () => {
      mockProfile.mockReturnValue("browser")
      await openMenu({ ...baseRow, enabled: false })
      const item = await screen.findByTestId("plugin-row-toggle-enabled")
      expect(item).toHaveAttribute("data-disabled")
      expect(item).toHaveTextContent("blockedTooltip")
    })

    it("labels a mirrored client's toggle as running on the desktop", async () => {
      mockMirrored.mockReturnValue(true)
      mockProfile.mockReturnValue("mobile")
      await openMenu({ ...baseRow, enabled: false })
      const item = await screen.findByTestId("plugin-row-toggle-enabled")
      expect(item).not.toHaveAttribute("data-disabled")
      expect(item).toHaveTextContent("runsOnDesktop")
    })

    it("disables Uninstall for a built-in with the reason inline", async () => {
      await openMenu({ ...baseRow, source: "builtin" })
      const item = await screen.findByTestId("plugin-row-uninstall")
      expect(item).toHaveAttribute("data-disabled")
      expect(item).toHaveTextContent("uninstallBlocked.builtin")
    })

    it("grows the trigger to 36px on a coarse pointer", () => {
      render(<PluginRowActionsMenu plugin={baseRow} {...callbacks()} />)
      expect(screen.getByLabelText("actionsMenuAria:Test Plugin")).toHaveClass(
        "pointer-coarse:size-9"
      )
    })
  })

  describe("availability of Configure / Review permissions", () => {
    async function openMenu(plugin: PluginRow) {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      render(<PluginRowActionsMenu plugin={plugin} {...callbacks()} />)
      await user.click(screen.getByLabelText(`actionsMenuAria:${plugin.name}`))
      await screen.findByText("openDetails")
    }

    it("hides Configure and Review permissions when the plugin has neither", async () => {
      await openMenu({ ...baseRow, manifest: { id: "p1" } as never })
      expect(screen.queryByText("configure")).not.toBeInTheDocument()
      expect(screen.queryByText("reviewPermissions")).not.toBeInTheDocument()
    })

    it("hides Configure for a schema with no properties", async () => {
      await openMenu({
        ...baseRow,
        manifest: { id: "p1", configSchema: { type: "object", properties: {} } } as never,
      })
      expect(screen.queryByText("configure")).not.toBeInTheDocument()
    })

    it("offers Configure for a Python plugin (host settings) without a schema", async () => {
      await openMenu({ ...baseRow, type: "python", manifest: { id: "p1" } as never })
      expect(screen.getByText("configure")).toBeInTheDocument()
    })

    it("offers Review permissions for optional-only permissions", async () => {
      await openMenu({
        ...baseRow,
        manifest: { id: "p1", optionalPermissions: ["clipboard:read"] } as never,
      })
      expect(screen.getByText("reviewPermissions")).toBeInTheDocument()
    })
  })

  describe("detail context", () => {
    it("drops Open details and the enable toggle, and renders the extra items", async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 })
      render(
        <PluginRowActionsMenu
          plugin={baseRow}
          {...callbacks()}
          context="detail"
          extraItems={<div role="menuitem">extra-item</div>}
        />
      )
      await user.click(screen.getByLabelText("actionsMenuAria:Test Plugin"))
      expect(await screen.findByText("extra-item")).toBeInTheDocument()
      expect(screen.queryByText("openDetails")).not.toBeInTheDocument()
      expect(screen.queryByTestId("plugin-row-toggle-enabled")).not.toBeInTheDocument()
      expect(screen.getByTestId("plugin-row-uninstall")).toBeInTheDocument()
    })
  })
})
