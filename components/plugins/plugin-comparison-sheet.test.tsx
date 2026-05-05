/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginComparisonSheet, PluginComparisonTrigger } from "./plugin-comparison-sheet"
import { usePluginMarketplaceStore } from "@/stores/plugin/plugin-marketplace-store"

// Reset the persistent store between tests so comparisonIds doesn't leak
// across cases. zustand's vanilla store API exposes .setState directly.
beforeEach(() => {
  act(() => {
    usePluginMarketplaceStore.setState({
      comparisonIds: [],
      comparisonOpen: false,
    })
  })
})

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Plugin ${id}`,
  version: "1.0.0",
  type: "plugin",
  description: "Sample",
  author: "Acme",
  rating: 4.2,
  downloads: 1000,
  signed: true,
  capabilities: ["tools"],
  permissions: ["clipboard:read"],
  ...overrides,
})

describe("PluginComparisonSheet", () => {
  it("auto-closes when the queue empties while the sheet is open", () => {
    act(() => {
      usePluginMarketplaceStore.setState({ comparisonOpen: true, comparisonIds: [] })
    })
    render(<PluginComparisonSheet entries={[entry("a")]} />)
    expect(usePluginMarketplaceStore.getState().comparisonOpen).toBe(false)
  })

  it("renders one column per queued id when sheet is open", () => {
    act(() => {
      usePluginMarketplaceStore.setState({
        comparisonOpen: true,
        comparisonIds: ["a", "b"],
      })
    })
    render(
      <PluginComparisonSheet
        entries={[entry("a"), entry("b"), entry("c")]}
        installedIds={new Set(["a"])}
      />
    )
    expect(screen.getByTestId("plugin-comparison-remove-a")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-comparison-remove-b")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-comparison-remove-c")).not.toBeInTheDocument()
  })

  it("clicking remove drops the entry from the store", () => {
    act(() => {
      usePluginMarketplaceStore.setState({
        comparisonOpen: true,
        comparisonIds: ["a", "b"],
      })
    })
    render(<PluginComparisonSheet entries={[entry("a"), entry("b")]} />)
    fireEvent.click(screen.getByTestId("plugin-comparison-remove-a"))
    expect(usePluginMarketplaceStore.getState().comparisonIds).toEqual(["b"])
  })

  it("clear button empties the queue and closes the sheet", () => {
    act(() => {
      usePluginMarketplaceStore.setState({
        comparisonOpen: true,
        comparisonIds: ["a", "b"],
      })
    })
    render(<PluginComparisonSheet entries={[entry("a"), entry("b")]} />)
    fireEvent.click(screen.getByText("clearAll"))
    expect(usePluginMarketplaceStore.getState().comparisonIds).toEqual([])
    expect(usePluginMarketplaceStore.getState().comparisonOpen).toBe(false)
  })

  it("install button on a queued entry calls onInstall", () => {
    const onInstall = jest.fn()
    act(() => {
      usePluginMarketplaceStore.setState({
        comparisonOpen: true,
        comparisonIds: ["a"],
      })
    })
    render(<PluginComparisonSheet entries={[entry("a")]} onInstall={onInstall} />)
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith("a", "1.0.0")
  })

  it("shows the installed badge instead of install when entry is already installed", () => {
    act(() => {
      usePluginMarketplaceStore.setState({
        comparisonOpen: true,
        comparisonIds: ["a"],
      })
    })
    render(<PluginComparisonSheet entries={[entry("a")]} installedIds={new Set(["a"])} />)
    expect(screen.getByText("installed")).toBeInTheDocument()
    expect(screen.queryByText("install")).not.toBeInTheDocument()
  })
})

describe("PluginComparisonTrigger", () => {
  it("renders nothing while comparisonIds is empty", () => {
    const { container } = render(<PluginComparisonTrigger />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a button with the queue count when not empty", async () => {
    act(() => {
      usePluginMarketplaceStore.setState({ comparisonIds: ["a"] })
    })
    render(<PluginComparisonTrigger />)
    expect(await screen.findByTestId("plugin-comparison-trigger")).toBeInTheDocument()
  })

  it("clicking the trigger flips comparisonOpen to true", async () => {
    act(() => {
      usePluginMarketplaceStore.setState({ comparisonIds: ["a"], comparisonOpen: false })
    })
    render(<PluginComparisonTrigger />)
    const button = await screen.findByTestId("plugin-comparison-trigger")
    fireEvent.click(button)
    expect(usePluginMarketplaceStore.getState().comparisonOpen).toBe(true)
  })
})
