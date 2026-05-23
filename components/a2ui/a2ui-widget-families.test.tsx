import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { A2UIComparisonCards } from "./display/a2ui-comparison-cards"
import { A2UIStepperShell } from "./layout/a2ui-stepper-shell"
import { A2UIMockupFrame } from "./layout/a2ui-mockup-frame"
import { A2UITable } from "./data/a2ui-table"
import { A2UIWidgetStatus } from "./display/a2ui-widget-status"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

// A2UITable reads dataModel via useA2UIData() — substitute the surrounding
// context so the explorer-mode sort state in `tableDataModel` is what the
// component sees.
let tableDataModel: Record<string, unknown> = {}
jest.mock("./a2ui-context", () => ({
  useA2UIData: () => ({
    surface: null,
    dataModel: tableDataModel,
    components: {},
    resolveString: (v: string | { path: string }) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: number | { path: string }) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: boolean | { path: string }) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: T[] | { path: string }, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
  useA2UIContext: () => ({ dataModel: tableDataModel }),
  useA2UIActions: () => ({}),
}))

function createBaseProps(component: Record<string, unknown>): A2UIComponentProps {
  return {
    component: component as never,
    surfaceId: "surface-1",
    dataModel: {
      stepIndex: 0,
      sort: {
        key: "score",
        direction: "asc",
      },
    },
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <div data-testid={`child-${id}`}>{id}</div>),
  }
}

describe("A2UI widget families", () => {
  it("renders comparison cards and emits click actions", () => {
    const props = createBaseProps({
      id: "comparison-1",
      component: "ComparisonCards",
      items: [
        { id: "alpha", title: "Alpha", value: "92", badge: "Fast" },
        { id: "beta", title: "Beta", value: "81", badge: "Stable" },
      ],
      itemClickAction: "inspect_option",
    })

    render(
      <A2UIComparisonCards
        {...(props as unknown as React.ComponentProps<typeof A2UIComparisonCards>)}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Alpha/i }))

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("92")).toBeInTheDocument()
    expect(props.onAction).toHaveBeenCalledWith("inspect_option", {
      itemId: "alpha",
      value: "92",
    })
  })

  it("renders a stepper shell and updates the current step", () => {
    const props = createBaseProps({
      id: "stepper-1",
      component: "StepperShell",
      title: "Plan",
      steps: [
        { id: "step-1", title: "Plan", description: "Start here." },
        { id: "step-2", title: "Build", description: "Continue here." },
      ],
      currentStep: { path: "/stepIndex" },
      currentStepPath: "/stepIndex",
      stepChangeAction: "step_changed",
    })

    render(
      <A2UIStepperShell {...(props as unknown as React.ComponentProps<typeof A2UIStepperShell>)} />
    )
    fireEvent.click(screen.getByRole("button", { name: /next/i }))

    expect(screen.getByText("Start here.")).toBeInTheDocument()
    expect(props.onDataChange).toHaveBeenCalledWith("/stepIndex", 1)
    expect(props.onAction).toHaveBeenCalledWith("step_changed", {
      stepId: "step-2",
      stepIndex: 1,
    })
  })

  it("renders a mockup frame around nested children", () => {
    const props = createBaseProps({
      id: "mockup-1",
      component: "MockupFrame",
      title: "Inbox Mockup",
      caption: "Review layout",
      frameStyle: "browser",
      children: ["hero"],
    })

    render(
      <A2UIMockupFrame {...(props as unknown as React.ComponentProps<typeof A2UIMockupFrame>)} />
    )

    expect(screen.getByText("Inbox Mockup")).toBeInTheDocument()
    expect(screen.getByText("Review layout")).toBeInTheDocument()
    expect(screen.getByTestId("child-hero")).toBeInTheDocument()
  })

  it("renders the merged Table in explorer mode and emits sort state changes", () => {
    // After the DataExplorer → Table merge, the same path-bound sort behavior
    // lives on A2UITable when `sortKeyPath` + `sortDirectionPath` are set.
    tableDataModel = { sort: { key: "score", direction: "asc" } }
    const props = createBaseProps({
      id: "explorer-1",
      component: "Table",
      columns: [
        { key: "name", header: "Name" },
        { key: "score", header: "Score", sortable: true },
      ],
      data: [
        { id: "row-1", name: "Alpha", score: 9 },
        { id: "row-2", name: "Beta", score: 7 },
      ],
      sortKeyPath: "/sort/key",
      sortDirectionPath: "/sort/direction",
      sortAction: "sort_dataset",
    })

    render(<A2UITable {...(props as unknown as React.ComponentProps<typeof A2UITable>)} />)

    const scoreHeader = screen.getByText("Score").closest("th")
    expect(scoreHeader).not.toBeNull()
    fireEvent.click(scoreHeader as HTMLElement)

    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(props.onDataChange).toHaveBeenCalledWith("/sort/key", "score")
    expect(props.onDataChange).toHaveBeenCalledWith("/sort/direction", "desc")
    expect(props.onAction).toHaveBeenCalledWith("sort_dataset", {
      direction: "desc",
      key: "score",
    })
  })

  it("renders widget status content", () => {
    const props = createBaseProps({
      id: "status-1",
      component: "WidgetStatus",
      status: "fallback",
      title: "Fallback active",
      message: "Using the native backup flow.",
    })

    render(
      <A2UIWidgetStatus {...(props as unknown as React.ComponentProps<typeof A2UIWidgetStatus>)} />
    )

    expect(screen.getByText("Fallback active")).toBeInTheDocument()
    expect(screen.getByText("Using the native backup flow.")).toBeInTheDocument()
    expect(screen.getByText("fallback")).toBeInTheDocument()
  })
})
