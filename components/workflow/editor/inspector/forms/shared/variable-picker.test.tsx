/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { VariablePicker } from "./variable-picker"
import type { VarTreeNodeInput } from "@/lib/workflow/editor/variable-tree"
import type { GraphEdgeLike } from "@/lib/workflow/editor/upstream-graph"

const messages = {
  workflows: {
    variablePicker: {
      trigger: "Insert variable",
      search: "Search variables…",
      empty: "No upstream variables available.",
    },
  },
}

const nodes: VarTreeNodeInput[] = [
  { id: "a", kind: "trigger.manual", label: "Start" },
  { id: "b", kind: "ai.prompt", label: "Draft" },
  { id: "c", kind: "ai.prompt", label: "Final" },
]
const edges: GraphEdgeLike[] = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
]

function renderPicker(onInsert = jest.fn(), currentNodeId = "c") {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <VariablePicker
        currentNodeId={currentNodeId}
        nodes={nodes}
        edges={edges}
        outputs={{ b: { result: { text: "hi" } }, a: { payload: 1 } }}
        onInsert={onInsert}
      />
    </NextIntlClientProvider>
  )
  return onInsert
}

describe("VariablePicker", () => {
  it("opens the popover and lists upstream nodes and their fields", () => {
    renderPicker()
    fireEvent.click(screen.getByTestId("variable-picker-trigger"))
    expect(screen.getByTestId("variable-picker-content")).toBeInTheDocument()
    expect(screen.getByTestId("variable-picker-node-b")).toBeInTheDocument()
    expect(screen.getByTestId("variable-picker-node-a")).toBeInTheDocument()
    // downstream/self never listed
    expect(screen.queryByTestId("variable-picker-node-c")).toBeNull()
    expect(screen.getByTestId("variable-picker-field-b-result.text")).toBeInTheDocument()
  })

  it("inserts a field reference on click", () => {
    const onInsert = renderPicker()
    fireEvent.click(screen.getByTestId("variable-picker-trigger"))
    fireEvent.click(screen.getByTestId("variable-picker-field-b-result.text"))
    expect(onInsert).toHaveBeenCalledWith("{{ $node['b'].result.text }}")
  })

  it("inserts the node base reference when the node header is clicked", () => {
    const onInsert = renderPicker()
    fireEvent.click(screen.getByTestId("variable-picker-trigger"))
    fireEvent.click(screen.getByTestId("variable-picker-node-b"))
    expect(onInsert).toHaveBeenCalledWith("{{ $node['b'] }}")
  })

  it("filters by the search query", () => {
    renderPicker()
    fireEvent.click(screen.getByTestId("variable-picker-trigger"))
    fireEvent.change(screen.getByTestId("variable-picker-search"), { target: { value: "text" } })
    expect(screen.getByTestId("variable-picker-field-b-result.text")).toBeInTheDocument()
    expect(screen.queryByTestId("variable-picker-field-a-payload")).toBeNull()
  })

  it("shows the empty state when the current node has no upstream", () => {
    renderPicker(jest.fn(), "a") // 'a' is the root trigger — nothing upstream
    fireEvent.click(screen.getByTestId("variable-picker-trigger"))
    expect(screen.getByTestId("variable-picker-empty")).toBeInTheDocument()
  })
})
