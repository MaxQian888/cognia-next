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
})
