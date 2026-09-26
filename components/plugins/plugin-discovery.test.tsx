/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  // `InstallButton` gates install on the desktop host, because the download
  // and checksum verification run in the Rust backend. These suites are about
  // what the surface renders and what it calls, not about the gate, which has
  // its own tests in `_shared/install-button.test.tsx`.
  canUseTauriInvoke: () => true,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/hooks/plugins", () => ({
  // The strip must read the panel's state, never run its own query: a second
  // hook sent every registry request twice on Discover.
  usePluginMarketplace: () => {
    throw new Error("PluginDiscovery must not run its own marketplace query")
  },
}))

import type { UsePluginMarketplace } from "@/hooks/plugins"
import { PluginDiscovery } from "./plugin-discovery"

const SAMPLE = [
  {
    id: "p1",
    name: "Plugin 1",
    version: "1.0.0",
    type: "plugin" as const,
    description: "",
  },
]

type MarketState = Pick<UsePluginMarketplace, "state" | "featured" | "installingId">

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    state: { kind: "ready", results: SAMPLE },
    featured: SAMPLE,
    installingId: null,
    ...overrides,
  }
}

describe("PluginDiscovery", () => {
  it("renders featured entries from the panel's marketplace state", () => {
    const { container } = render(<PluginDiscovery market={market()} onInstall={jest.fn()} />)
    expect(screen.getByText("Plugin 1")).toBeInTheDocument()
    expect(container.querySelector("[data-slot='card-header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-content']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-footer']")).not.toBeNull()
  })

  it("renders nothing while loading or when nothing is featured", () => {
    // The marketplace below owns the spinner and the empty card.
    const { container, rerender } = render(
      <PluginDiscovery market={market({ state: { kind: "loading" } })} onInstall={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<PluginDiscovery market={market({ featured: [] })} onInstall={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("install button delegates to the onInstall prop with id + version", () => {
    const onInstall = jest.fn()
    render(<PluginDiscovery market={market()} onInstall={onInstall} />)
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith("p1", "1.0.0")
  })

  it("shows the installing state for the entry the panel is installing", () => {
    render(<PluginDiscovery market={market({ installingId: "p1" })} onInstall={jest.fn()} />)
    expect(screen.getByText("installing")).toBeInTheDocument()
  })
})
