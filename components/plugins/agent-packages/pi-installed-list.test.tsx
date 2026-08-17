/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import { resolvePiPackages } from "@/lib/pi-packages/resolve"
import type { PiPackageSource } from "@/lib/pi-packages/types"
import messages from "@/i18n/messages/en.json"
import { PiInstalledList } from "./pi-installed-list"

const BASE = { user: "/home/u/.pi/agent", project: "/repo/.pi" }

interface Handlers {
  onToggle: jest.Mock
  onRemove: jest.Mock
  onConfigure: jest.Mock
}

function renderList(
  user: readonly PiPackageSource[],
  project: readonly PiPackageSource[] = [],
  busySpec: string | null = null
): Handlers {
  const handlers: Handlers = {
    onToggle: jest.fn(),
    onRemove: jest.fn(),
    onConfigure: jest.fn(),
  }
  render(
    // `app/layout.tsx` mounts TooltipProvider app-wide; tests have to supply it.
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <PiInstalledList
          resolved={resolvePiPackages(user, project, BASE)}
          busySpec={busySpec}
          {...handlers}
        />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
  return handlers
}

describe("PiInstalledList", () => {
  it("shows an empty state when neither scope declares anything", () => {
    renderList([])
    expect(screen.getByTestId("pi-installed-empty")).toBeInTheDocument()
  })

  it("renders a reviewed package with its summary and version", () => {
    renderList(["npm:pi-memory@0.4.2"])
    expect(screen.getByText("pi-memory")).toBeInTheDocument()
    expect(screen.getByText("0.4.2")).toBeInTheDocument()
    expect(screen.getByText(/Seven memory tools/i)).toBeInTheDocument()
  })

  /** Unreviewed is a distinct claim from free, and the row must say which. */
  it("marks an unreviewed package as not in the catalog", () => {
    renderList(["npm:pi-hermes-memory@1.0.0"])
    expect(screen.getByText(/Not in Cognia's reviewed catalog/i)).toBeInTheDocument()
  })

  it("tags each row with the scope it came from", () => {
    renderList(["npm:a"], ["npm:b"])
    expect(screen.getByText("User")).toBeInTheDocument()
    expect(screen.getByText("Project")).toBeInTheDocument()
  })

  /**
   * Pi's one non-obvious merge rule: an `autoload: false` project entry layers
   * over the user entry instead of replacing it, so both rows survive and the
   * layered one must be labelled as such.
   */
  it("labels a project delta as layered and keeps the user row", () => {
    renderList(["npm:a@1.0.0"], [{ source: "npm:a", autoload: false }])
    expect(screen.getByText("Layered")).toBeInTheDocument()
    expect(screen.getByText("User")).toBeInTheDocument()
    expect(screen.getByText("Project")).toBeInTheDocument()
  })

  /** Pi has no `enabled` field — inert is `autoload: false`, not "off". */
  it("shows a disabled package as inert with the switch off", () => {
    renderList([{ source: "npm:pi-memory@0.4.2", autoload: false }])
    expect(screen.getByText("Inert")).toBeInTheDocument()
    expect(screen.getByRole("switch")).not.toBeChecked()
  })

  it("marks an entry that narrows which resources Pi loads", () => {
    renderList([{ source: "npm:pi-memory@0.4.2", skills: [] }])
    expect(screen.getByText("Filtered")).toBeInTheDocument()
  })

  it("flags an installed package the review says to avoid", () => {
    renderList(["npm:pi-finish-notification@1.0.4"])
    expect(screen.getByText("Avoid")).toBeInTheDocument()
  })

  it("passes the spec and scope through when toggling", async () => {
    const handlers = renderList(["npm:pi-memory@0.4.2"])
    await userEvent.click(screen.getByRole("switch"))
    expect(handlers.onToggle).toHaveBeenCalledWith("npm:pi-memory@0.4.2", "user", false)
  })

  it("passes the spec and scope through when removing", async () => {
    const handlers = renderList([], ["npm:pi-memory@0.4.2"])
    await userEvent.click(screen.getByRole("button", { name: /remove/i }))
    expect(handlers.onRemove).toHaveBeenCalledWith("npm:pi-memory@0.4.2", "project")
  })

  it("only offers configure for packages that have reviewed defaults", () => {
    renderList(["npm:@narumitw/pi-statusline@0.49.6"])
    expect(screen.getByRole("button", { name: /configure/i })).toBeInTheDocument()
  })

  it("hides configure for a package with no reviewed defaults", () => {
    renderList(["npm:pi-atelier@0.8.1"])
    expect(screen.queryByRole("button", { name: /configure/i })).not.toBeInTheDocument()
  })

  it("disables the row's controls while that spec is mutating", () => {
    renderList(["npm:pi-memory@0.4.2"], [], "npm:pi-memory@0.4.2")
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByRole("button", { name: /remove/i })).toBeDisabled()
  })

  it("leaves other rows enabled while one is mutating", () => {
    renderList(["npm:pi-memory@0.4.2", "npm:pi-atelier@0.8.1"], [], "npm:pi-memory@0.4.2")
    const switches = screen.getAllByRole("switch")
    expect(switches[0]).toBeDisabled()
    expect(switches[1]).toBeEnabled()
  })
})
