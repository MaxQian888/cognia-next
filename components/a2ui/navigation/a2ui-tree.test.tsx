import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { A2UITreeComponent } from "@/types/artifact/a2ui"

jest.mock("../a2ui-context", () => ({
  useA2UIData: () => ({
    resolveString: (value: unknown, fallback = "") =>
      typeof value === "string" ? value : fallback,
  }),
}))

import { A2UITree } from "./a2ui-tree"

const OUTLINE: A2UITreeComponent["nodes"] = [
  {
    id: "src",
    label: "src",
    children: [
      {
        id: "src/lib",
        label: "lib",
        children: [{ id: "src/lib/utils.ts", label: "utils.ts" }],
      },
      { id: "src/main.ts", label: "main.ts" },
    ],
  },
  { id: "README.md", label: "README.md" },
]

function props(
  component: A2UITreeComponent,
  onAction = jest.fn()
): A2UIComponentProps<A2UITreeComponent> {
  return {
    component,
    surfaceId: "surface",
    dataModel: {},
    onAction,
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  }
}

function tree(over: Partial<A2UITreeComponent> = {}): A2UITreeComponent {
  return { id: "tree", component: "Tree", nodes: OUTLINE, ...over }
}

describe("A2UITree", () => {
  it("expands only the first level by default", () => {
    render(<A2UITree {...props(tree())} />)
    expect(screen.getByText("src")).toBeInTheDocument()
    expect(screen.getByText("lib")).toBeInTheDocument()
    // Depth 2 stays closed — the whole point of a tree over a flat list.
    expect(screen.queryByText("utils.ts")).not.toBeInTheDocument()
  })

  it("honours a deeper default and a per-node override", () => {
    render(<A2UITree {...props(tree({ defaultExpandedDepth: 2 }))} />)
    expect(screen.getByText("utils.ts")).toBeInTheDocument()

    render(
      <A2UITree
        {...props(
          tree({
            defaultExpandedDepth: 0,
            nodes: [{ ...OUTLINE[0], defaultExpanded: true }],
          })
        )}
      />
    )
    expect(screen.getAllByText("lib").length).toBeGreaterThan(0)
  })

  it("reveals and hides a branch when its chevron is pressed", async () => {
    const user = userEvent.setup()
    render(<A2UITree {...props(tree())} />)
    const branch = screen.getByRole("treeitem", { name: /lib/ })
    expect(branch).toHaveAttribute("aria-expanded", "false")

    await user.click(screen.getByRole("button", { name: "Expand" }))
    expect(screen.getByText("utils.ts")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Collapse" })[1])
    expect(screen.queryByText("utils.ts")).not.toBeInTheDocument()
  })

  it("reports expansion separately from selection so a branch can lazy-load", async () => {
    const user = userEvent.setup()
    const onAction = jest.fn()
    render(<A2UITree {...props(tree({ action: "select", expandAction: "expand" }), onAction)} />)

    await user.click(screen.getByRole("button", { name: "Expand" }))
    expect(onAction).toHaveBeenCalledWith("expand", { nodeId: "src/lib", expanded: true })
    expect(onAction).not.toHaveBeenCalledWith("select", expect.anything())
  })

  it("emits the select action with the node id", async () => {
    const user = userEvent.setup()
    const onAction = jest.fn()
    render(<A2UITree {...props(tree({ action: "open" }), onAction)} />)

    await user.click(screen.getByText("main.ts"))
    expect(onAction).toHaveBeenCalledWith("open", { nodeId: "src/main.ts" })
  })

  it("toggles a branch whose label is clicked when no select action is declared", async () => {
    const user = userEvent.setup()
    render(<A2UITree {...props(tree())} />)
    await user.click(screen.getByText("lib"))
    expect(screen.getByText("utils.ts")).toBeInTheDocument()
  })

  it("never activates a disabled node", async () => {
    const user = userEvent.setup()
    const onAction = jest.fn()
    render(
      <A2UITree
        {...props(
          tree({ action: "open", nodes: [{ id: "locked", label: "locked", disabled: true }] }),
          onAction
        )}
      />
    )
    await user.click(screen.getByText("locked"))
    expect(onAction).not.toHaveBeenCalled()
  })

  it("marks the selected node for assistive tech, not just visually", () => {
    render(<A2UITree {...props(tree({ selectedId: "src/main.ts" }))} />)
    expect(screen.getByRole("treeitem", { name: /main\.ts/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("exposes depth so a screen reader can announce nesting", () => {
    render(<A2UITree {...props(tree())} />)
    expect(screen.getByRole("treeitem", { name: /^src/ })).toHaveAttribute("aria-level", "1")
    expect(screen.getByRole("treeitem", { name: /lib/ })).toHaveAttribute("aria-level", "2")
  })

  it("falls back to a localized empty state, and lets the plugin override it", () => {
    const { unmount } = render(<A2UITree {...props(tree({ nodes: [] }))} />)
    expect(screen.getByText("Nothing to show")).toBeInTheDocument()
    unmount()

    render(<A2UITree {...props(tree({ nodes: [], emptyLabel: "No pages yet" }))} />)
    expect(screen.getByText("No pages yet")).toBeInTheDocument()
  })
})
