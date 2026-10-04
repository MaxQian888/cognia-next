/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AgentTraceTreeView } from "./agent-trace-tree"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  const id = over.id ?? over.spanId ?? "span-" + Math.random().toString(36).slice(2, 8)
  return {
    id,
    spanId: id,
    traceId: "t1",
    startTime: 0,
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "s1",
    surface: "chat",
    ...over,
  }
}

describe("AgentTraceTreeView", () => {
  it("renders a loading placeholder when spans is null", () => {
    render(<AgentTraceTreeView spans={null} />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("renders an empty hint when spans is []", () => {
    render(<AgentTraceTreeView spans={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders one row per span with operation name + duration", () => {
    render(
      <AgentTraceTreeView
        spans={[
          makeSpan({
            id: "a",
            operationName: "invoke_agent",
            durationMs: 250,
            requestModel: "claude-opus-4-7",
            usage: {
              inputTokens: 100,
              outputTokens: 30,
              cacheCreationTokens: 0,
              cacheReadTokens: 5,
            },
            costUsdEstimate: 0.005,
          }),
        ]}
      />
    )
    const row = screen.getByTestId("agent-trace-tree-row-a")
    expect(row.textContent).toContain("invoke_agent")
    expect(row.textContent).toContain("claude-opus-4-7")
    // Token split is a message (word order is the translator's), not "100/30t".
    expect(row.textContent).toContain('tokens:{"input":"100","output":"30"}')
    expect(row.textContent).toContain("$0.0050")
    expect(row.textContent).toContain("250ms")
  })

  it("nests children under parents and orders chronologically", () => {
    const parent = makeSpan({
      id: "root",
      operationName: "invoke_agent",
      startTime: 100,
      durationMs: 1000,
    })
    const childB = makeSpan({
      id: "child-b",
      operationName: "execute_tool",
      toolName: "Read",
      startTime: 300,
      durationMs: 100,
      parentSpanId: "root",
    })
    const childA = makeSpan({
      id: "child-a",
      operationName: "execute_tool",
      toolName: "Bash",
      startTime: 200,
      durationMs: 50,
      parentSpanId: "root",
    })
    render(<AgentTraceTreeView spans={[parent, childB, childA]} />)
    // A nested list, not an ARIA tree with none of the tree keyboard contract.
    expect(screen.queryByRole("tree")).not.toBeInTheDocument()
    const rows = screen.getAllByTestId(/^agent-trace-tree-row-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "agent-trace-tree-row-root",
      "agent-trace-tree-row-child-a",
      "agent-trace-tree-row-child-b",
    ])
    const rootItem = rows[0].closest("li")!
    const childItem = rows[1].closest("li")!
    // The child's list item lives in a list nested inside the root's item.
    expect(rootItem.contains(childItem)).toBe(true)
    expect(childItem.parentElement?.tagName).toBe("UL")
  })

  it("promotes orphan children (parentSpanId not in set) to root", () => {
    const orphan = makeSpan({
      id: "orphan",
      parentSpanId: "missing",
      startTime: 50,
    })
    render(<AgentTraceTreeView spans={[orphan]} />)
    const item = screen.getByTestId("agent-trace-tree-row-orphan").closest("li")!
    // Top level: its list is the outermost one, labelled as the span tree.
    expect(item.parentElement).toHaveAttribute("aria-label", "treeLabel")
  })

  it("marks the active span via aria-current", () => {
    render(
      <AgentTraceTreeView
        spans={[makeSpan({ id: "x", startTime: 1 }), makeSpan({ id: "y", startTime: 2 })]}
        activeSpanId="y"
      />
    )
    expect(screen.getByTestId("agent-trace-tree-row-x").closest("li")).not.toHaveAttribute(
      "aria-current"
    )
    expect(screen.getByTestId("agent-trace-tree-row-y").closest("li")).toHaveAttribute(
      "aria-current",
      "true"
    )
  })

  it("keeps the raw operation id as the label's title", () => {
    render(<AgentTraceTreeView spans={[makeSpan({ id: "x", operationName: "execute_tool" })]} />)
    expect(screen.getByTitle("execute_tool")).toBeInTheDocument()
  })

  it("folds the model column by container query, not a viewport breakpoint", () => {
    render(<AgentTraceTreeView spans={[makeSpan({ id: "x", requestModel: "opus" })]} />)
    expect(screen.getByText("opus")).toHaveClass("@md:inline")
    expect(screen.getByTestId("agent-trace-tree")).toHaveClass("@container")
  })

  it("styles error spans with destructive marker", () => {
    render(
      <AgentTraceTreeView
        spans={[
          makeSpan({
            id: "e",
            errorType: "tool_error",
            errorMessage: "boom",
            durationMs: 30,
          }),
        ]}
      />
    )
    const row = screen.getByTestId("agent-trace-tree-row-e")
    expect(row.className).toMatch(/text-destructive/)
    // Colour is not the only signal.
    expect(row).toHaveTextContent("failed")
  })

  it("formats durations: ms / s / min thresholds", () => {
    render(
      <AgentTraceTreeView
        spans={[
          makeSpan({ id: "ms", durationMs: 250 }),
          makeSpan({ id: "sec", durationMs: 1_500 }),
          makeSpan({ id: "min", durationMs: 65_000 }),
        ]}
      />
    )
    expect(screen.getByTestId("agent-trace-tree-row-ms").textContent).toContain("250ms")
    expect(screen.getByTestId("agent-trace-tree-row-sec").textContent).toContain("1.5s")
    expect(screen.getByTestId("agent-trace-tree-row-min").textContent).toContain("1.1m")
  })

  it("omits cost when 0 or missing", () => {
    render(
      <AgentTraceTreeView spans={[makeSpan({ id: "x", costUsdEstimate: 0, durationMs: 5 })]} />
    )
    expect(screen.getByTestId("agent-trace-tree-row-x").textContent).not.toContain("$")
  })

  it("displays toolName / agentName as the inline subject", () => {
    render(
      <AgentTraceTreeView
        spans={[
          makeSpan({
            id: "tool",
            operationName: "execute_tool",
            toolName: "list_files",
            durationMs: 10,
          }),
          makeSpan({
            id: "agt",
            operationName: "invoke_agent",
            agentName: "Researcher",
            startTime: 1,
            durationMs: 20,
          }),
        ]}
      />
    )
    expect(screen.getByTestId("agent-trace-tree-row-tool").textContent).toContain("list_files")
    expect(screen.getByTestId("agent-trace-tree-row-agt").textContent).toContain("Researcher")
  })
})
