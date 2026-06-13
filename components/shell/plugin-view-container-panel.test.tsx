/**
 * @jest-environment jsdom
 */

import { render, screen, act } from "@testing-library/react"
import { PluginViewContainerPanel } from "./plugin-view-container-panel"
import {
  registerViewContainer,
  __resetViewContainersForTesting,
} from "@/lib/plugin/registries/view-container-registry"
import { registerView, __resetViewsForTesting } from "@/lib/plugin/registries/tree-view-registry"
import { __resetContextKeysForTesting } from "@/lib/plugin/context-keys/context-key-store"
import type { TreeDataProvider } from "@/types/plugin/plugin-view"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

afterEach(() => {
  __resetViewContainersForTesting()
  __resetViewsForTesting()
  __resetContextKeysForTesting()
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

  it("renders a registered tree view in the container body (B2)", async () => {
    const provider: TreeDataProvider = {
      getChildren: (parentId) => (parentId ? [] : [{ id: "n", label: "Tree Node" }]),
    }
    act(() => {
      registerViewContainer({ id: "explorer", title: "Explorer" }, { pluginId: "p" })
      registerView({
        kind: "tree",
        pluginId: "p",
        viewId: "files",
        containerId: "p:explorer",
        provider,
      })
    })
    render(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(await screen.findByText("Tree Node")).toBeInTheDocument()
    // Empty-state should NOT show when a view is present.
    expect(screen.queryByText("empty")).not.toBeInTheDocument()
  })

  it("hides a view whose when-clause is unmet", () => {
    const provider: TreeDataProvider = { getChildren: () => [{ id: "n", label: "Gated Node" }] }
    act(() => {
      registerViewContainer({ id: "explorer", title: "Explorer" }, { pluginId: "p" })
      registerView({
        kind: "tree",
        pluginId: "p",
        viewId: "files",
        containerId: "p:explorer",
        when: "chat.active",
        provider,
      })
    })
    render(<PluginViewContainerPanel containerId="p:explorer" />)
    // Clause unmet → view hidden → empty state shows.
    expect(screen.getByText("empty")).toBeInTheDocument()
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
