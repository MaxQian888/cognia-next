/**
 * @jest-environment jsdom
 */

import { render, screen, act } from "@testing-library/react"
import { PluginViewContainerPanel } from "./plugin-view-container-panel"
import {
  registerViewContainer,
  __resetViewContainersForTesting,
} from "@/lib/plugin/registries/view-container-registry"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

afterEach(() => {
  __resetViewContainersForTesting()
})

describe("PluginViewContainerPanel", () => {
  it("renders the container header (title) for a registered container", () => {
    act(() => {
      registerViewContainer({ id: "explorer", title: "My Explorer" }, { pluginId: "p" })
    })
    render(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(screen.getByText("My Explorer")).toBeInTheDocument()
    expect(
      screen.getByText("My Explorer").closest("[data-plugin-view-container='p:explorer']")
    ).not.toBeNull()
  })

  it("resolves a lucide icon name supplied by the container", () => {
    act(() => {
      registerViewContainer({ id: "files", title: "Files", icon: "Folder" }, { pluginId: "p" })
    })
    const { container } = render(<PluginViewContainerPanel containerId="p:files" />)
    // The resolved lucide icon renders as an <svg> in the header.
    expect(container.querySelector("svg")).not.toBeNull()
    expect(screen.getByText("Files")).toBeInTheDocument()
  })

  it("falls back to the puzzle glyph for an unknown icon name", () => {
    act(() => {
      registerViewContainer(
        { id: "x", title: "X", icon: "NotARealLucideIconName" },
        { pluginId: "p" }
      )
    })
    const { container } = render(<PluginViewContainerPanel containerId="p:x" />)
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("shows the empty-state message for the container body", () => {
    act(() => {
      registerViewContainer({ id: "explorer", title: "My Explorer" }, { pluginId: "p" })
    })
    render(<PluginViewContainerPanel containerId="p:explorer" />)
    // useTranslations is mocked to echo the key.
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("shows the unavailable state when the container is not registered", () => {
    render(<PluginViewContainerPanel containerId="ghost:gone" />)
    expect(screen.getByText("unavailable")).toBeInTheDocument()
    expect(document.querySelector("[data-plugin-view-container='unavailable']")).not.toBeNull()
  })

  it("re-renders when the container is unregistered (becomes unavailable)", () => {
    act(() => {
      registerViewContainer({ id: "explorer", title: "My Explorer" }, { pluginId: "p" })
    })
    const { rerender } = render(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(screen.getByText("My Explorer")).toBeInTheDocument()
    act(() => {
      __resetViewContainersForTesting()
    })
    rerender(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(screen.getByText("unavailable")).toBeInTheDocument()
  })
})
