/**
 * @jest-environment jsdom
 */

import { render, screen, act, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PluginTreeViewHost } from "./plugin-tree-view-host"
import type { PluginTreeNode, TreeDataProvider } from "@/types/plugin/plugin-view"
import { registerCommand, __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"

afterEach(() => __resetCommandRegistryForTesting())

function staticProvider(tree: Record<string, PluginTreeNode[]>): TreeDataProvider {
  return { getChildren: (parentId) => tree[parentId ?? "__root__"] ?? [] }
}

describe("PluginTreeViewHost", () => {
  it("renders root nodes from the provider", async () => {
    const provider = staticProvider({
      __root__: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    })
    render(<PluginTreeViewHost provider={provider} pluginId="p" />)
    expect(await screen.findByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })

  it("lazily loads children on expand", async () => {
    const user = userEvent.setup()
    const provider = staticProvider({
      __root__: [{ id: "dir", label: "Folder", expandable: true }],
      dir: [{ id: "child", label: "Child" }],
    })
    render(<PluginTreeViewHost provider={provider} pluginId="p" />)
    expect(await screen.findByText("Folder")).toBeInTheDocument()
    expect(screen.queryByText("Child")).not.toBeInTheDocument()
    await user.click(screen.getByText("Folder"))
    expect(await screen.findByText("Child")).toBeInTheDocument()
  })

  it("dispatches a node's command on click", async () => {
    const user = userEvent.setup()
    const handler = jest.fn()
    registerCommand({ id: "demo.open", pluginId: "p", handler })
    const provider = staticProvider({
      __root__: [{ id: "leaf", label: "Open", command: "demo.open" }],
    })
    render(<PluginTreeViewHost provider={provider} pluginId="p" />)
    await user.click(await screen.findByText("Open"))
    await waitFor(() => expect(handler).toHaveBeenCalled())
  })

  it("refreshes when the provider signals onDidChangeTreeData", async () => {
    let nodes: PluginTreeNode[] = [{ id: "a", label: "First" }]
    let fire: () => void = () => {}
    const provider: TreeDataProvider = {
      getChildren: (parentId) => (parentId ? [] : nodes),
      onDidChangeTreeData: (listener) => {
        fire = listener
        return () => {}
      },
    }
    render(<PluginTreeViewHost provider={provider} pluginId="p" />)
    expect(await screen.findByText("First")).toBeInTheDocument()
    nodes = [{ id: "b", label: "Second" }]
    act(() => fire())
    expect(await screen.findByText("Second")).toBeInTheDocument()
    expect(screen.queryByText("First")).not.toBeInTheDocument()
  })

  it("tolerates a throwing getChildren (renders empty, no crash)", async () => {
    const provider: TreeDataProvider = {
      getChildren: () => {
        throw new Error("boom")
      },
    }
    render(<PluginTreeViewHost provider={provider} pluginId="p" />)
    // No nodes rendered, tree container still present.
    expect(document.querySelector("[data-plugin-tree-view='p']")).not.toBeNull()
  })
})
