/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("@/hooks/plugins/use-plugin-rollback-availability", () => ({
  usePluginRollbackAvailable: () => true,
}))

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    // Chips print the capability's name and count through one template.
    if (key === "capabilityChipLabel" && vars) return `${vars.name} · ${vars.count}`
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

const mockSimulated = new Set<string>()
jest.mock("@/lib/plugin/ide/dev-mode", () => ({
  subscribeDevMode: () => () => undefined,
  devModeVersion: () => 0,
  isPluginSimulated: (pluginId: string) => mockSimulated.has(pluginId),
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
  it("marks a plugin whose permissions Managed IDE Dev Mode is simulating", () => {
    const cb = callbacks()
    const { rerender } = render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    expect(screen.queryByTestId("plugin-simulated-badge-plugin_test")).toBeNull()
    mockSimulated.add("plugin_test")
    rerender(<PluginCard plugin={{ ...baseRow }} selected={false} {...cb} />)
    expect(screen.getByTestId("plugin-simulated-badge-plugin_test")).toHaveTextContent("simulated")
    mockSimulated.clear()
  })

  it("renders core metadata", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    expect(screen.getByText("Test Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
    expect(screen.getByText("plugin_test")).toBeInTheDocument()
  })

  // Regression: in narrow grid columns the metadata footer + name badges must
  // wrap, not overflow the card (status pill / "update available" spilling past
  // the border). Lock the wrap classes so the layout fix can't silently regress.
  it("lets the name-badge row and metadata footer wrap to avoid overflow", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{ ...baseRow, manifest: { ...baseRow.manifest, updateAvailable: true } }}
        selected={false}
        {...cb}
      />
    )
    // Name row carries version + update badges; must wrap below the name.
    const nameRow = screen.getByText("Test Plugin").parentElement as HTMLElement
    expect(nameRow).toHaveClass("flex-wrap")

    // Source badge sits in the footer's left group; that group and the footer
    // itself both wrap so the status pill drops below instead of overflowing.
    const sourceBadge = screen.getByTestId("plugin-source-badge-marketplace")
    const leftGroup = sourceBadge.parentElement as HTMLElement
    expect(leftGroup).toHaveClass("flex-wrap", "min-w-0")
    const footer = leftGroup.parentElement as HTMLElement
    expect(footer).toHaveClass("flex-wrap", "justify-between")
  })

  it("renders capability chips with overflow indicator beyond the 3-chip cap", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    expect(screen.getByText("capability.tools")).toBeInTheDocument()
    expect(screen.getByText("capability.commands")).toBeInTheDocument()
    // 5 caps total, 3 shown + "+2" — aligned with the marketplace card
    // so the same plugin renders consistently across browse vs library.
    expect(screen.getByText("+2")).toBeInTheDocument()
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
    fireEvent.click(screen.getByLabelText("selectAria:Test Plugin"))
    expect(cb.onToggleSelect).toHaveBeenCalledWith("plugin_test")
  })

  it("threads the plugin name through the localized selectAria key", () => {
    const cb = callbacks()
    render(<PluginCard plugin={{ ...baseRow, name: "Other Name" }} selected={false} {...cb} />)
    expect(screen.getByLabelText("selectAria:Other Name")).toBeInTheDocument()
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

  it("renders capability chips with inline contribution counts when manifest provides them", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{
          ...baseRow,
          capabilities: ["tools"],
          manifest: {
            ...baseRow.manifest,
            tools: [{ id: "a" }, { id: "b" }, { id: "c" }],
          },
        }}
        selected={false}
        {...cb}
      />
    )
    expect(screen.getByText("capability.tools · 3")).toBeInTheDocument()
  })

  it("tags the errored card with data-errored and a destructive tint", () => {
    const cb = callbacks()
    const { container } = render(
      <PluginCard
        plugin={{ ...baseRow, status: "error", error: "boom" }}
        selected={false}
        {...cb}
      />
    )
    const card = container.querySelector('[data-errored="true"]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.className).toContain("bg-destructive/5")
  })

  it("names the source with the shared source badge, not the raw enum", () => {
    const cb = callbacks()
    render(<PluginCard plugin={{ ...baseRow, source: "dev" }} selected={false} {...cb} />)
    // The badge renders `plugins.source.dev` (the mocked translator returns
    // the key) and marks a development build.
    expect(screen.getByTestId("plugin-source-badge-dev")).toHaveTextContent("dev")
  })

  it("flags every canonical dangerous permission, not a hand-picked four", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{
          ...baseRow,
          manifest: { id: "plugin_test", permissions: ["network:fetch", "clipboard:read"] },
        }}
        selected={false}
        {...cb}
      />
    )
    expect(screen.getByRole("img", { name: "dangerousPermissionsAria:1" })).toBeInTheDocument()
  })

  it("does not flag a plugin holding only standard permissions", () => {
    const cb = callbacks()
    render(
      <PluginCard
        plugin={{ ...baseRow, manifest: { id: "plugin_test", permissions: ["clipboard:read"] } }}
        selected={false}
        {...cb}
      />
    )
    expect(screen.queryByRole("img", { name: /dangerousPermissionsAria/ })).toBeNull()
  })

  // A <button> may only hold phrasing content; the card used to put block
  // <div>s (and every badge) inside one.
  it("keeps the open button free of block content and other controls", () => {
    const cb = callbacks()
    render(<PluginCard plugin={baseRow} selected={false} {...cb} />)
    const open = screen.getByTestId("plugin-card-open-plugin_test")
    expect(open.tagName).toBe("BUTTON")
    expect(open.querySelector("div, button, [role='button']")).toBeNull()
    expect(open).toHaveAccessibleName("Test Plugin")
    // The stretched pseudo-element makes the whole card the hit area.
    expect(open.className).toContain("after:inset-0")
    // Controls above the stretched area keep their own clicks.
    const checkboxLabel = screen.getByLabelText("selectAria:Test Plugin").closest("label")!
    expect(checkboxLabel.className).toContain("z-10")
  })

  it("treats a lifecycle error as errored and shows its message", () => {
    const cb = callbacks()
    const { container } = render(
      <PluginCard
        plugin={{
          ...baseRow,
          status: "installed",
          lifecycle: {
            intent: "enabled",
            actual: "error",
            revision: 1,
            lastError: "activation threw",
            updatedAt: 0,
          },
        }}
        selected={false}
        {...cb}
      />
    )
    expect(container.querySelector('[data-errored="true"]')).not.toBeNull()
    expect(screen.getByText("activation threw")).toBeInTheDocument()
    expect(screen.getAllByText("error").length).toBeGreaterThan(0)
  })
})
