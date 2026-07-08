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
import {
  registerWebview,
  __resetWebviewsForTesting,
} from "@/lib/plugin/registries/webview-registry"
import { __resetContextKeysForTesting } from "@/lib/plugin/context-keys/context-key-store"
import type { TreeDataProvider } from "@/types/plugin/plugin-view"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

afterEach(() => {
  __resetViewContainersForTesting()
  __resetViewsForTesting()
  __resetWebviewsForTesting()
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

  it("mounts a custom react view and gives its section a fill layout", () => {
    function Panel() {
      return <div data-testid="react-panel">Panel body</div>
    }
    act(() => {
      registerViewContainer({ id: "explorer", title: "Explorer" }, { pluginId: "p" })
      registerView({
        kind: "react",
        pluginId: "p",
        viewId: "panel",
        containerId: "p:explorer",
        component: Panel,
      })
    })
    const { container } = render(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(screen.getByTestId("react-panel")).toBeInTheDocument()
    // The wrapping section must establish a definite height so a full-bleed
    // panel's inner `h-full`/`flex-1` chain resolves (regression guard).
    const section = container.querySelector("[data-plugin-view='p:panel']")
    expect(section?.className).toContain("flex-1")
    expect(section?.className).toContain("min-h-0")
  })

  it("keeps a tree view section hug-height (no fill classes)", () => {
    const provider: TreeDataProvider = { getChildren: () => [{ id: "n", label: "Node" }] }
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
    const { container } = render(<PluginViewContainerPanel containerId="p:explorer" />)
    const section = container.querySelector("[data-plugin-view='p:files']")
    expect(section?.className ?? "").not.toContain("flex-1")
  })

  it("suppresses the host header when the container sets hideHeader", () => {
    act(() => {
      registerViewContainer({ id: "sec", title: "Security", hideHeader: true }, { pluginId: "p" })
    })
    render(<PluginViewContainerPanel containerId="p:sec" />)
    // No host chrome renders the title; the body (empty-state here) still shows.
    expect(screen.queryByText("Security")).not.toBeInTheDocument()
    expect(screen.getByText("empty")).toBeInTheDocument()
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

  it("renders a registered panel webview in the container body (B3)", () => {
    act(() => {
      registerViewContainer({ id: "explorer", title: "Explorer" }, { pluginId: "p" })
      registerWebview({
        pluginId: "p",
        viewId: "dash",
        containerId: "p:explorer",
        surface: "panel",
        srcDoc: "<h1>WV</h1>",
      })
    })
    const { container } = render(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(container.querySelector("[data-plugin-webview='p:dash']")).not.toBeNull()
    expect(screen.queryByText("empty")).not.toBeInTheDocument()
  })

  it("does not render a webview with surface 'window' in the panel body", () => {
    act(() => {
      registerViewContainer({ id: "explorer", title: "Explorer" }, { pluginId: "p" })
      registerWebview({
        pluginId: "p",
        viewId: "win",
        containerId: "p:explorer",
        surface: "window",
        srcDoc: "<h1>W</h1>",
      })
    })
    const { container } = render(<PluginViewContainerPanel containerId="p:explorer" />)
    expect(container.querySelector("[data-plugin-webview='p:win']")).toBeNull()
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
