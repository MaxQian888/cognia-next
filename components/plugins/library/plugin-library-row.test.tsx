/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

import { PluginLibraryRow } from "./plugin-library-row"

const baseRow: PluginRow = {
  id: "p1",
  name: "Test Plugin",
  version: "1.0.0",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: ["tools", "modes"],
  path: "/p/test",
  manifest: { id: "p1", permissions: ["clipboard:read"] },
  createdAt: 0,
  updatedAt: 0,
}

const handlers = () => ({
  onToggleSelect: jest.fn(),
  onOpen: jest.fn(),
  onConfigure: jest.fn(),
  onToggleEnabled: jest.fn(),
  onUninstall: jest.fn(),
  onReviewPermissions: jest.fn(),
})

describe("PluginLibraryRow", () => {
  it("renders the plugin name, version and id", () => {
    const h = handlers()
    render(<PluginLibraryRow plugin={baseRow} selected={false} active={false} {...h} />)
    expect(screen.getByText("Test Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    expect(screen.getByText("p1")).toBeInTheDocument()
  })

  it("clicking the row body invokes onOpen", () => {
    const h = handlers()
    render(<PluginLibraryRow plugin={baseRow} selected={false} active={false} {...h} />)
    fireEvent.click(screen.getByTestId("plugin-library-row-p1"))
    expect(h.onOpen).toHaveBeenCalledWith("p1")
  })

  it("clicking the checkbox invokes onToggleSelect", () => {
    const h = handlers()
    render(<PluginLibraryRow plugin={baseRow} selected={false} active={false} {...h} />)
    fireEvent.click(screen.getByLabelText("selectAria:Test Plugin"))
    expect(h.onToggleSelect).toHaveBeenCalledWith("p1")
  })

  it("renders the update badge when the manifest flags it", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{ ...baseRow, manifest: { ...baseRow.manifest, updateAvailable: true } }}
        selected={false}
        active={false}
        {...h}
      />
    )
    expect(screen.getByText("updateBadge")).toBeInTheDocument()
  })

  it("highlights the row when active is true via data-active=true", () => {
    const h = handlers()
    const { container } = render(
      <PluginLibraryRow plugin={baseRow} selected={false} active={true} {...h} />
    )
    expect(container.querySelector('[data-active="true"]')).toBeTruthy()
  })

  it("shows the inline error message when status=error", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{ ...baseRow, status: "error", error: "load failed" }}
        selected={false}
        active={false}
        {...h}
      />
    )
    expect(screen.getByText("load failed")).toBeInTheDocument()
  })

  it("tags errored rows with data-errored and a destructive tint", () => {
    const h = handlers()
    const { container } = render(
      <PluginLibraryRow
        plugin={{ ...baseRow, status: "error", error: "load failed" }}
        selected={false}
        active={false}
        {...h}
      />
    )
    const row = container.querySelector('[data-errored="true"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.className).toContain("bg-destructive/5")
    expect(screen.getByLabelText("erroredAria")).toBeInTheDocument()
  })

  it("renders a left accent bar via before: pseudo-element when active", () => {
    const h = handlers()
    const { container } = render(
      <PluginLibraryRow plugin={baseRow} selected={false} active={true} {...h} />
    )
    const row = container.querySelector('[data-active="true"]') as HTMLElement
    expect(row.className).toContain("before:bg-primary")
    expect(row.className).toContain("before:w-[3px]")
  })

  it("renders capability chips with inline contribution counts when manifest provides them", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{
          ...baseRow,
          capabilities: ["tools", "modes"],
          manifest: {
            ...baseRow.manifest,
            tools: [{ id: "tool-a" }, { id: "tool-b" }],
            modes: [{ id: "mode-1" }],
          },
        }}
        selected={false}
        active={false}
        {...h}
      />
    )
    // Capability label is "tools · 2" / "modes · 1" once contribution count is known.
    expect(screen.getByText("tools · 2")).toBeInTheDocument()
    expect(screen.getByText("modes · 1")).toBeInTheDocument()
  })

  it("falls back to a plain capability label when no manifest entries match", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{ ...baseRow, capabilities: ["hooks"] }}
        selected={false}
        active={false}
        {...h}
      />
    )
    expect(screen.getByText("hooks")).toBeInTheDocument()
  })

  it("shows the +N overflow badge when there are more than 3 capabilities", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{
          ...baseRow,
          capabilities: ["tools", "modes", "themes", "skills", "commands"],
        }}
        selected={false}
        active={false}
        {...h}
      />
    )
    expect(screen.getByText("+2")).toBeInTheDocument()
  })
})
