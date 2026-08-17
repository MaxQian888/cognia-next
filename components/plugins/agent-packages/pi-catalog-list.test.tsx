/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import { PI_PACKAGE_CATALOG, PI_STACK_PRESETS, piCatalogEntry } from "@/lib/pi-packages/catalog"
import { piPackageIdentity } from "@/lib/pi-packages/identity"
import { resolvePiPackages } from "@/lib/pi-packages/resolve"
import type { PiPackageSource } from "@/lib/pi-packages/types"
import messages from "@/i18n/messages/en.json"
import { PiCatalogList, presetGap } from "./pi-catalog-list"

interface Handlers {
  onInstall: jest.Mock
  onApplyPreset: jest.Mock
}

function renderCatalog(installed: readonly PiPackageSource[] = []): Handlers {
  const handlers: Handlers = { onInstall: jest.fn(), onApplyPreset: jest.fn() }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <PiCatalogList
          resolved={resolvePiPackages(installed, [])}
          busySpec={null}
          applyingPreset={null}
          {...handlers}
        />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
  return handlers
}

describe("presetGap", () => {
  it("returns the whole preset when nothing is installed", () => {
    expect(presetGap("balanced", new Set())).toHaveLength(PI_STACK_PRESETS.balanced.length)
  })

  it("excludes what is already installed, ignoring the pin", () => {
    const installed = new Set([piPackageIdentity("npm:@aliou/pi-guardrails@0.1.0")])
    const gap = presetGap("starter", installed)
    expect(gap.map((entry) => entry.id)).toEqual(["narumitw-pi-statusline"])
  })

  it("is empty once every package in the preset is present", () => {
    const installed = new Set(
      PI_STACK_PRESETS.starter.map((id) => piPackageIdentity(piCatalogEntry(id)!.spec))
    )
    expect(presetGap("starter", installed)).toEqual([])
  })
})

describe("PiCatalogList", () => {
  it("renders every catalog row", () => {
    renderCatalog()
    for (const entry of PI_PACKAGE_CATALOG) {
      expect(screen.getByTestId(`pi-catalog-${entry.id}`)).toBeInTheDocument()
    }
  })

  /** Catalog order *is* the recommendation; re-sorting would discard it. */
  it("keeps catalog order rather than sorting", () => {
    renderCatalog()
    // The install buttons share the prefix, so match the row elements only.
    const rows = screen.getAllByTestId(/^pi-catalog-/).filter((node) => node.tagName === "LI")
    expect(rows.map((row) => row.dataset.testid)).toEqual(
      PI_PACKAGE_CATALOG.map((entry) => `pi-catalog-${entry.id}`)
    )
  })

  it("shows each row's tier and risk", () => {
    renderCatalog()
    expect(screen.getByTestId("pi-catalog-pi-memory")).toHaveTextContent("Optional")
    expect(screen.getByTestId("pi-catalog-pi-memory")).toHaveTextContent(/Seven schemas/i)
  })

  it("marks avoid-tier rows as such", () => {
    renderCatalog()
    expect(screen.getByTestId("pi-catalog-pi-finish-notification")).toHaveTextContent("Avoid")
  })

  it("disables install for a package that is already there", () => {
    renderCatalog(["npm:pi-memory@0.4.2"])
    expect(screen.getByTestId("pi-catalog-install-pi-memory")).toBeDisabled()
    expect(screen.getByTestId("pi-catalog-install-pi-atelier")).toBeEnabled()
  })

  /** Identity ignores the pin, so a different version still counts as present. */
  it("treats a differently-pinned install as installed", () => {
    renderCatalog(["npm:pi-memory@0.1.0"])
    expect(screen.getByTestId("pi-catalog-install-pi-memory")).toBeDisabled()
  })

  it("hands the exact pinned spec to the install handler", async () => {
    const handlers = renderCatalog()
    await userEvent.click(screen.getByTestId("pi-catalog-install-pi-memory"))
    expect(handlers.onInstall).toHaveBeenCalledWith("npm:pi-memory@0.4.2")
  })

  it("filters rows by the search box", async () => {
    renderCatalog()
    await userEvent.type(screen.getByLabelText(/search packages/i), "memory")
    expect(screen.getByTestId("pi-catalog-pi-memory")).toBeInTheDocument()
    expect(screen.queryByTestId("pi-catalog-narumitw-pi-statusline")).not.toBeInTheDocument()
  })

  it("installs an arbitrary spec typed by hand", async () => {
    const handlers = renderCatalog()
    await userEvent.type(screen.getByLabelText(/install by spec/i), "npm:whatever@1.0.0")
    await userEvent.click(screen.getAllByRole("button", { name: "Install" })[0])
    expect(handlers.onInstall).toHaveBeenCalledWith("npm:whatever@1.0.0")
  })

  it("reports how many packages a preset would add", () => {
    renderCatalog()
    expect(screen.getByTestId("pi-preset-apply-starter")).toHaveTextContent("Installs 2 packages")
  })

  it("marks a fully-satisfied preset as done and disables it", () => {
    renderCatalog(["npm:@aliou/pi-guardrails@0.17.0", "npm:@narumitw/pi-statusline@0.49.6"])
    const button = screen.getByTestId("pi-preset-apply-starter")
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent(/already installed|Everything in this stack/i)
  })

  /** Presets add; they never remove. The handler only ever receives the gap. */
  it("passes only the missing packages to the preset handler", async () => {
    const handlers = renderCatalog(["npm:@aliou/pi-guardrails@0.17.0"])
    await userEvent.click(screen.getByTestId("pi-preset-apply-starter"))
    const [preset, missing] = handlers.onApplyPreset.mock.calls[0]
    expect(preset).toBe("starter")
    expect(missing.map((entry: { id: string }) => entry.id)).toEqual(["narumitw-pi-statusline"])
  })
})
