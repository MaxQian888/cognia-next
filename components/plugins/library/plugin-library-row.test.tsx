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

jest.mock("../_shared/plugin-compatibility-badge", () => ({
  PluginCompatibilityBadge: () => <div data-testid="compatibility-badge-stub" />,
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
  manifest: { id: "p1", author: { name: "Acme Labs" }, permissions: ["clipboard:read"] },
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
  it("renders the plugin name, version and author", () => {
    const h = handlers()
    render(<PluginLibraryRow plugin={baseRow} selected={false} active={false} {...h} />)
    expect(screen.getByText("Test Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    expect(screen.getByText("Acme Labs")).toBeInTheDocument()
  })

  it("accepts a plain-string author as well as the object form", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{ ...baseRow, manifest: { ...baseRow.manifest, author: "Solo Dev" } }}
        selected={false}
        active={false}
        {...h}
      />
    )
    expect(screen.getByText("Solo Dev")).toBeInTheDocument()
  })

  // The row id used to occupy the second line, which is where the capability
  // chips now live. The id stays available on the detail pane and as a data
  // attribute, so nothing that needs it lost its source.
  it("no longer prints the raw plugin id in the row body", () => {
    const h = handlers()
    render(<PluginLibraryRow plugin={baseRow} selected={false} active={false} {...h} />)
    expect(screen.queryByText("p1")).not.toBeInTheDocument()
  })

  // Regression guard for the a11y defect this row used to carry: the avatar,
  // title, capability chips and the activation-progress control all lived
  // inside ONE <button>, so the focusable chips were unreachable and the
  // markup was invalid. The open affordance must wrap the name only.
  it("keeps focusable controls out of the open button", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{
          ...baseRow,
          manifest: { ...baseRow.manifest, tools: [{ id: "tool-a" }] },
        }}
        selected={false}
        active={false}
        {...h}
      />
    )
    const openButton = screen.getByTestId("plugin-library-row-p1")
    expect(openButton.querySelector("button, [tabindex]")).toBeNull()
    expect(openButton.textContent).toBe("Test Plugin")
    // The stretched hit area is what keeps the whole row clickable.
    expect(openButton.className).toContain("after:absolute")
    expect(openButton.className).toContain("after:inset-0")
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

  // Both of these were being produced and shown nowhere in the DEFAULT view:
  // the compatibility diagnostic had no reader at all, and the loader's
  // degraded-runtime markers were rendered only by the card grid. A row could
  // read "Enabled" over a runtime that never started.
  it("carries the compatibility badge", () => {
    const h = handlers()
    render(<PluginLibraryRow plugin={baseRow} selected={false} active={false} {...h} />)
    expect(screen.getByTestId("compatibility-badge-stub")).toBeInTheDocument()
  })

  it("renders the loader's degraded-runtime markers", () => {
    const h = handlers()
    render(
      <PluginLibraryRow
        plugin={{
          ...baseRow,
          manifest: { ...baseRow.manifest, _cogniaWarnings: ["wasm-runtime-unavailable"] },
        }}
        selected={false}
        active={false}
        {...h}
      />
    )
    expect(
      screen.getByTestId("plugin-runtime-warning-wasm-runtime-unavailable")
    ).toBeInTheDocument()
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

  it.each(["dev", "local"] as const)("badges a %s build, which is not a released one", (source) => {
    // An unmarked dev build in the list is how an author ends up debugging a
    // copy they are not running.
    render(
      <PluginLibraryRow
        plugin={{ ...baseRow, source }}
        selected={false}
        active={false}
        {...handlers()}
      />
    )
    expect(screen.getByTestId(`plugin-source-badge-${source}`)).toBeInTheDocument()
  })

  it.each(["marketplace", "builtin"] as const)("does not badge a released %s build", (source) => {
    // Every row saying "Marketplace" would be noise, and noise is what makes
    // the dev badge stop being a signal.
    render(
      <PluginLibraryRow
        plugin={{ ...baseRow, source }}
        selected={false}
        active={false}
        {...handlers()}
      />
    )
    expect(screen.queryByTestId(`plugin-source-badge-${source}`)).not.toBeInTheDocument()
  })
})
