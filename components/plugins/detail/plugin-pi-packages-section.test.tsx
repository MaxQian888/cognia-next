/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import type { ContributedPiPackage } from "@/lib/plugin/pi-packages/registry"
import type { PluginManifest } from "@/types/plugin"
import messages from "@/i18n/messages/en.json"
import { PluginPiPackagesSection } from "./plugin-pi-packages-section"

let mockEntries: ContributedPiPackage[] = []
jest.mock("@/hooks/plugins/use-contributed-pi-packages", () => ({
  useContributedPiPackageEntries: () => mockEntries,
}))
const mockPi = { loading: false, snapshot: null }
jest.mock("@/hooks/plugins/use-pi-packages", () => ({ usePiPackages: () => mockPi }))
jest.mock("@/components/plugins/agent-packages/contributed-pi-package-list", () => ({
  ContributedPiPackageList: ({ pluginId, pi }: { pluginId?: string; pi: unknown }) => (
    <div data-testid="list" data-plugin-id={pluginId} data-has-pi={String(pi === mockPi)} />
  ),
}))

const manifest = (piPackages?: unknown): PluginManifest =>
  ({ id: "latex-workbench", piPackages }) as unknown as PluginManifest

function renderSection(m: PluginManifest) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PluginPiPackagesSection pluginId="latex-workbench" manifest={m} />
    </NextIntlClientProvider>
  )
}

describe("PluginPiPackagesSection", () => {
  beforeEach(() => {
    mockEntries = []
  })

  it("renders nothing for a plugin without piPackages", () => {
    const { container } = renderSection(manifest())
    expect(container).toBeEmptyDOMElement()
  })

  it("names the packages and asks to enable a disabled plugin", () => {
    renderSection(manifest([{ id: "latex", name: "LaTeX", path: "pi" }]))
    expect(screen.getByTestId("plugin-pi-packages-section")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-pi-packages-disabled")).toHaveTextContent("latex")
    expect(screen.getByText(/Enable this plugin/)).toBeInTheDocument()
    expect(screen.queryByTestId("list")).not.toBeInTheDocument()
  })

  it("delegates to the shared list, narrowed to this plugin, once registered", () => {
    mockEntries = [
      {
        def: { id: "latex", name: "LaTeX", path: "pi" },
        installRoot: "/p/latex-workbench",
        pluginId: "latex-workbench",
        ref: "latex-workbench/latex",
      },
    ]
    renderSection(manifest([{ id: "latex", name: "LaTeX", path: "pi" }]))
    const list = screen.getByTestId("list")
    expect(list).toHaveAttribute("data-plugin-id", "latex-workbench")
    expect(list).toHaveAttribute("data-has-pi", "true")
  })
})
