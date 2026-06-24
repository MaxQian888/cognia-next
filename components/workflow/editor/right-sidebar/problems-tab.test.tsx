/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { ProblemsTab } from "./problems-tab"

const messages = {
  workflows: {
    diagnostics: {
      title: "Problems",
      empty: "No problems detected.",
      filterAll: "All",
      filterErrors: "Errors",
      filterWarnings: "Warnings",
      exprUnknownNode: "References an unknown node ({ref}).",
      orphanNode: "Not reachable from any trigger.",
      missingTrigger: "No trigger.",
    },
    // `nodeParam` diagnostics carry a full-path messageKey rooted here, NOT
    // under `workflows.diagnostics`. The Problems tab must resolve them with a
    // root translator — otherwise the key is double-prefixed and goes MISSING.
    validation: {
      required: "This field is required",
      cronExpr: "Use a 5-field cron expression",
    },
  },
}

function workflow(): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "WF",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "t",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Trigger", params: {} },
      },
      {
        id: "p",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt", params: { userPrompt: "{{ $node['ghost'].out.x }}" } },
      },
      {
        id: "island",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 400, y: 0 },
        data: { label: "Island", params: { userPrompt: "hi" } },
      },
    ],
    edges: [{ id: "e1", source: "t", target: "p" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

function renderTab(reactFlowInstance?: unknown) {
  const store = createEditorStore(workflow())
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProblemsTab useStore={store} reactFlowInstance={reactFlowInstance as never} />
    </NextIntlClientProvider>
  )
  return store
}

describe("ProblemsTab", () => {
  it("lists diagnostics with the node label and a translated message", () => {
    renderTab()
    const rows = screen.getAllByTestId("problems-row")
    // exprUnknownNode (error, on p) + orphanNode (warning, on island).
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/unknown node \(ghost\)/i)).toBeInTheDocument()
    expect(screen.getByText(/not reachable/i)).toBeInTheDocument()
    expect(screen.getByText("Prompt")).toBeInTheDocument()
  })

  it("filters to errors only", () => {
    renderTab()
    fireEvent.click(screen.getByTestId("problems-filter-errors"))
    const rows = screen.getAllByTestId("problems-row")
    expect(rows.every((r) => r.getAttribute("data-severity") === "error")).toBe(true)
    expect(screen.queryByText(/not reachable/i)).not.toBeInTheDocument()
  })

  it("reveals the node on the canvas when a row is clicked", () => {
    const setViewport = jest.fn()
    const setCenter = jest.fn()
    const store = renderTab({ setViewport, setCenter })
    const errorRow = screen
      .getAllByTestId("problems-row")
      .find((r) => r.getAttribute("data-severity") === "error")!
    fireEvent.click(errorRow)
    // Pane-aware centering — must use setCenter, not window-width setViewport
    // math (which lands the node right of centre with the sidebar open).
    expect(setViewport).not.toHaveBeenCalled()
    expect(setCenter).toHaveBeenCalledTimes(1)
    const [cx, cy, opts] = setCenter.mock.calls[0]
    expect(typeof cx).toBe("number")
    expect(typeof cy).toBe("number")
    expect(opts.zoom).toBeCloseTo(1.2)
    expect(store.getState().selectedNodeIds).toEqual(["p"])
  })

  it("renders a node-param error (validation namespace) and selects the node on click", () => {
    const wf: VisualWorkflow = {
      ...workflow(),
      nodes: [
        {
          id: "t",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Trigger", params: {} },
        },
        {
          id: "cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "Cron", params: {} },
        },
      ],
      edges: [],
    }
    const store = createEditorStore(wf)
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProblemsTab useStore={store} />
      </NextIntlClientProvider>
    )
    const row = screen.getAllByTestId("problems-row").find((r) => r.textContent?.includes("Cron"))!
    expect(row).toBeTruthy()
    // The validation message resolves via the root translator — the raw key
    // (or a double-prefixed `workflows.diagnostics.workflows.validation.*`)
    // must NOT leak into the row.
    expect(row.textContent).not.toContain("workflows.validation")
    expect(row.textContent).toMatch(/cron expression|field is required/i)
    fireEvent.click(row)
    expect(store.getState().selectedNodeIds).toEqual(["cron"])
  })

  it("selects the edge when an edge-targeted diagnostic row is clicked", () => {
    const wf: VisualWorkflow = {
      ...workflow(),
      nodes: [
        {
          id: "t",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Trigger", params: {} },
        },
      ],
      // Edge to a node that doesn't exist → danglingTarget (carries edgeId, no nodeId).
      edges: [{ id: "bad_edge", source: "t", target: "ghost_node" }],
    }
    const store = createEditorStore(wf)
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProblemsTab useStore={store} />
      </NextIntlClientProvider>
    )
    const rows = screen.getAllByTestId("problems-row")
    const edgeRow = rows.find((r) => r.getAttribute("data-severity") === "error")!
    fireEvent.click(edgeRow)
    expect(store.getState().selectedEdgeIds).toEqual(["bad_edge"])
  })

  it("shows the empty state when there are no problems", () => {
    const clean: VisualWorkflow = {
      ...workflow(),
      nodes: [
        {
          id: "t",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "Trigger", params: {} },
        },
      ],
      edges: [],
    }
    const store = createEditorStore(clean)
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProblemsTab useStore={store} />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("problems-empty")).toBeInTheDocument()
  })
})
