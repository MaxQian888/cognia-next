/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { GroupContainerNode } from "./group-container-node"

jest.mock("@xyflow/react", () => ({
  __esModule: true,
  NodeResizer: ({ isVisible }: { isVisible?: boolean }) => (
    <span data-testid="node-resizer" data-visible={isVisible ? "true" : "false"} />
  ),
}))

function renderGroup({
  id = "grp1",
  selected = false,
  params = { title: "My Group", color: "emerald" } as Record<string, unknown>,
  locked = false,
}: {
  id?: string
  selected?: boolean
  params?: Record<string, unknown>
  locked?: boolean
} = {}) {
  return render(
    <GroupContainerNode
      id={id}
      type="groupContainer"
      selected={selected}
      data={{ label: "Group label", params, kind: "annotation.group", typeVersion: 2, locked }}
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      dragging={false}
      zIndex={0}
      isConnectable
      deletable
      selectable
      draggable
    />
  )
}

describe("GroupContainerNode", () => {
  it("renders the title and drop hint", () => {
    renderGroup()
    expect(screen.getByTestId("group-container-title")).toHaveTextContent("My Group")
    expect(screen.getByTestId("group-container-dropzone")).toBeInTheDocument()
  })

  it("falls back to the node label, then the untitled string", () => {
    renderGroup({ params: {} })
    expect(screen.getByTestId("group-container-title")).toHaveTextContent("Group label")
  })

  it("shows the resizer only when selected and unlocked", () => {
    renderGroup({ selected: true })
    expect(screen.getByTestId("node-resizer").getAttribute("data-visible")).toBe("true")
    renderGroup({ id: "grp2", selected: true, locked: true })
    // locked group: resizer hidden
    const resizers = screen.getAllByTestId("node-resizer")
    expect(resizers[resizers.length - 1].getAttribute("data-visible")).toBe("false")
  })

  it("renders a locked badge when locked", () => {
    renderGroup({ locked: true })
    expect(screen.getByTestId("group-container-locked")).toBeInTheDocument()
  })

  it("tolerates an unknown color and empty params", () => {
    renderGroup({ id: "grp3", params: { color: "chartreuse" } })
    expect(screen.getByTestId("wf-group-container-grp3")).toBeInTheDocument()
  })

  it("falls back to the untitled string when title and label are empty", () => {
    render(
      <GroupContainerNode
        id="grp4"
        type="groupContainer"
        selected={false}
        data={{ label: "", params: {}, kind: "annotation.group", typeVersion: 2 }}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        dragging={false}
        zIndex={0}
        isConnectable
        deletable
        selectable
        draggable
      />
    )
    // The default "untitled" group label is "Group".
    expect(screen.getByTestId("group-container-title")).toHaveTextContent("Group")
  })

  it("dims a disabled group", () => {
    renderGroup({ id: "grp5", params: { title: "D" } })
    render(
      <GroupContainerNode
        id="grp6"
        type="groupContainer"
        selected={false}
        data={{
          label: "x",
          params: { title: "D" },
          kind: "annotation.group",
          typeVersion: 2,
          disabled: true,
        }}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        dragging={false}
        zIndex={0}
        isConnectable
        deletable
        selectable
        draggable
      />
    )
    expect(screen.getByTestId("wf-group-container-grp6").className).toContain("opacity-50")
  })
})
