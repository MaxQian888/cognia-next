/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { PanelTransition } from "./panel-transition"
import { useSettingsStore } from "@/stores/settings/settings-store"

describe("PanelTransition", () => {
  it("renders a plain wrapper (no AnimatePresence branch) when motion is reduced", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: true, speed: 1 } } as never })
    const { container, getByTestId } = render(
      <PanelTransition activeKey="overview" className="pane">
        <span data-testid="body">overview</span>
      </PanelTransition>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.tagName).toBe("DIV")
    expect(wrapper.className).toBe("pane")
    expect(getByTestId("body")).toBeTruthy()
  })

  it("renders an animated wrapper carrying the className when motion is enabled", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
    const { container, getByTestId } = render(
      <PanelTransition activeKey="usage" className="pane">
        <span data-testid="body">usage</span>
      </PanelTransition>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.tagName).toBe("DIV")
    expect(wrapper.className).toBe("pane")
    expect(getByTestId("body")).toBeTruthy()
  })

  it("swaps the rendered panel when activeKey changes", () => {
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1.5 } } as never })
    const { getByTestId, queryByTestId, rerender } = render(
      <PanelTransition activeKey="overview">
        <span data-testid="overview">overview</span>
      </PanelTransition>
    )
    expect(getByTestId("overview")).toBeTruthy()

    rerender(
      <PanelTransition activeKey="usage">
        <span data-testid="usage">usage</span>
      </PanelTransition>
    )
    expect(getByTestId("usage")).toBeTruthy()
    expect(queryByTestId("overview")).toBeNull()
  })
})
