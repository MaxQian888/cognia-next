/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import { PlanPanel } from "./plan-panel"
import { DEFAULT_PLAN_CONFIG, type AgentPlan } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))

const applyPlanEditPatch = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/agent/plan/draft-edit", () => ({
  applyPlanEditPatch: (...a: unknown[]) => applyPlanEditPatch(...a),
}))

function makePlan(id: string, status: AgentPlan["status"], title = id): AgentPlan {
  return {
    id,
    sessionId: "ses",
    projectId: "proj",
    title,
    source: "exit_plan_mode",
    status,
    executionMode: "in_session",
    refinementCount: 0,
    config: { ...DEFAULT_PLAN_CONFIG, errorPolicy: "stop", maxConcurrency: 1 },
    steps: [
      {
        id: `${id}-s1`,
        planId: id,
        order: 0,
        title: "Do the thing",
        kind: "agent_turn",
        status: status === "completed" ? "completed" : "pending",
        dependencies: [],
        attempts: 0,
      },
    ],
    totalSteps: 1,
    completedSteps: status === "completed" ? 1 : 0,
    generationId: `${id}-gen`,
    metadata: {},
    createdAt: id === "p-new" ? 2 : 1,
    updatedAt: 1,
  } as AgentPlan
}

/** First useLiveQuery call serves plans (dep = sessionId), second serves
 *  events (dep = plan id). */
function mockQueries(plans: AgentPlan[], events: unknown[] = []) {
  useLiveQueryMock.mockImplementation((_q: unknown, deps: unknown[]) =>
    deps?.[0] === "ses" ? plans : events
  )
}

describe("PlanPanel", () => {
  beforeEach(() => {
    useLiveQueryMock.mockReset()
    applyPlanEditPatch.mockClear()
  })

  it("renders nothing while the plans query resolves", () => {
    useLiveQueryMock.mockReturnValue(undefined)
    const { container } = render(<PlanPanel sessionId="ses" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the empty state when the session has no plans", () => {
    mockQueries([])
    render(<PlanPanel sessionId="ses" />)
    expect(screen.getByTestId("plan-panel-empty")).toHaveTextContent("document.noPlans")
  })

  it("prefers the open plan and marks it current in the history selector", () => {
    mockQueries([makePlan("p-new", "awaiting_approval"), makePlan("p-old", "completed")])
    render(<PlanPanel sessionId="ses" />)
    const select = screen.getByTestId("plan-panel-history") as HTMLSelectElement
    expect(select.value).toBe("p-new")
    expect(select.options[0].textContent).toContain("document.currentPlan")
    expect(select.options[1].textContent).not.toContain("document.currentPlan")
  })

  it("lets an awaiting-approval plan autosave through the shared edit path", async () => {
    jest.useFakeTimers()
    try {
      mockQueries([makePlan("p-new", "awaiting_approval")])
      render(<PlanPanel sessionId="ses" />)
      // Editable rows are wired for the open plan…
      const input = screen.getByTestId("plan-doc-step-0") as HTMLInputElement
      fireEvent.change(input, { target: { value: "Do it differently" } })
      // …and the debounce flushes into the shared persistence helper.
      await act(async () => jest.advanceTimersByTime(1000))
      expect(applyPlanEditPatch).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p-new" }),
        expect.objectContaining({ stepTitles: ["Do it differently"] })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("renders terminal plans read-only and shows their event trail", () => {
    mockQueries(
      [makePlan("p-old", "completed")],
      [{ id: "e1", planId: "p-old", kind: "approved", ts: 1, payload: { kind: "approved" } }]
    )
    render(<PlanPanel sessionId="ses" />)
    expect(screen.queryByTestId("plan-doc-step-0")).not.toBeInTheDocument()
    expect(screen.getByTestId("plan-doc-events")).toHaveTextContent("document.eventKind.approved")
  })

  it("switches the view when a historical plan is selected", () => {
    mockQueries([makePlan("p-new", "awaiting_approval", "New"), makePlan("p-old", "failed", "Old")])
    render(<PlanPanel sessionId="ses" />)
    fireEvent.change(screen.getByTestId("plan-panel-history"), { target: { value: "p-old" } })
    expect(screen.queryByTestId("plan-doc-step-0")).not.toBeInTheDocument()
    expect(screen.getByText("status.failed")).toBeInTheDocument()
  })
})
