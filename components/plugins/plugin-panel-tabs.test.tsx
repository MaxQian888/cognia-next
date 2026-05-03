/**
 * @jest-environment jsdom
 */

import { render, screen, act } from "@testing-library/react"
import { Tabs } from "@/components/ui/tabs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver
})

import { PluginPanelTabs } from "./plugin-panel-tabs"

describe("PluginPanelTabs", () => {
  it("renders all 7 trigger buttons", () => {
    render(
      <Tabs value="installed">
        <PluginPanelTabs />
      </Tabs>
    )
    for (const id of [
      "installed",
      "browse",
      "configure",
      "permissions",
      "scheduled",
      "analytics",
      "devtools",
    ]) {
      expect(screen.getAllByRole("tab", { name: new RegExp(id) }).length).toBeGreaterThan(0)
    }
  })

  it("hides scroll-fade affordances when there is no overflow", () => {
    render(
      <Tabs value="installed">
        <PluginPanelTabs />
      </Tabs>
    )
    expect(screen.queryByTestId("plugin-panel-tabs-fade-left")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plugin-panel-tabs-fade-right")).not.toBeInTheDocument()
  })

  it("renders the right-edge fade once the scroller reports overflow", () => {
    render(
      <Tabs value="installed">
        <PluginPanelTabs />
      </Tabs>
    )
    const scroller = screen.getByTestId("plugin-panel-tabs-scroller")
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
    })
    Object.defineProperty(scroller, "clientWidth", {
      configurable: true,
      get: () => 100,
    })
    Object.defineProperty(scroller, "scrollWidth", {
      configurable: true,
      get: () => 400,
    })
    act(() => {
      scroller.dispatchEvent(new Event("scroll"))
    })
    expect(screen.getByTestId("plugin-panel-tabs-fade-right")).toBeInTheDocument()
  })
})
