import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RoutingTestPanel } from "./routing-test-panel"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const save = jest.fn().mockResolvedValue(undefined)
let traceRows: AgentTraceSpan[] = []
let traceError: Error | undefined
const mockQueryRecent = jest.fn(() =>
  traceError ? Promise.reject(traceError) : Promise.resolve(traceRows)
)

const stateRef: { current: Record<string, unknown> } = {
  current: {
    settings: {
      modelMappings: [
        {
          id: "m1",
          alias: "fast",
          providers: [
            { providerId: "groq", modelId: "llama" },
            { providerId: "openai", modelId: "gpt-4o-mini" },
          ],
          distribution: "priority",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      routingConfig: { ...DEFAULT_ROUTING_CONFIG, strategy: "quality" },
      autoRouting: { shadowMode: true },
      providerSettings: {},
      customProviders: [],
    },
    save,
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

jest.mock("@/lib/db/agent-traces", () => ({
  queryRecent: () => mockQueryRecent(),
}))

beforeEach(() => {
  traceRows = []
  traceError = undefined
  mockQueryRecent.mockClear()
  save.mockClear()
})

describe("RoutingTestPanel", () => {
  it("previews an alias through the real engine and shows the chain", async () => {
    const user = userEvent.setup()
    render(<RoutingTestPanel />)
    await user.type(screen.getByLabelText("Type an alias, e.g. fast"), "fast")
    await user.click(screen.getByRole("button", { name: /Preview/ }))

    const result = await screen.findByTestId("preview-result")
    expect(result).toBeInTheDocument()
    // quality strategy = first entry (appears in the resolved badge AND the chain).
    expect(screen.getAllByText("groq:llama").length).toBeGreaterThan(0)
    expect(screen.getByTestId("fallback-chain")).toBeInTheDocument()
    expect(screen.getByText(/Shadow decision matches/)).toBeInTheDocument()
  })

  it("shows no-route for an unknown alias", async () => {
    const user = userEvent.setup()
    render(<RoutingTestPanel />)
    await user.type(screen.getByLabelText("Type an alias, e.g. fast"), "nope{Enter}")
    expect(await screen.findByTestId("preview-no-candidates")).toBeInTheDocument()
  })

  it("shows local classification and reasons for Auto without dispatching", async () => {
    const user = userEvent.setup()
    render(<RoutingTestPanel />)
    await user.click(screen.getByRole("button", { name: "Auto" }))
    await user.type(
      screen.getByLabelText("Optional prompt for local classification"),
      "Analyze and refactor this algorithm step by step"
    )
    await user.click(screen.getByRole("button", { name: /Preview/ }))

    expect(await screen.findByTestId("preview-result")).toHaveTextContent("Automatic task fit")
    expect(screen.getByText(/Coding ·/)).toBeInTheDocument()
  })

  it("shows the pruning filters when a candidate was dropped", async () => {
    const prev = stateRef.current
    stateRef.current = {
      settings: {
        ...(prev.settings as Record<string, unknown>),
        // groq disabled → the circuit filter prunes it; openai survives.
        providerSettings: { groq: { providerId: "groq", enabled: false } },
      },
    }
    try {
      const user = userEvent.setup()
      render(<RoutingTestPanel />)
      await user.type(screen.getByLabelText("Type an alias, e.g. fast"), "fast{Enter}")
      expect(await screen.findByTestId("preview-result")).toBeInTheDocument()
      expect(screen.getAllByText("openai:gpt-4o-mini").length).toBeGreaterThan(0)
      expect(screen.getByTestId("preview-notes")).toHaveTextContent("circuit")
    } finally {
      stateRef.current = prev
    }
  })

  it("shows the no-viable-provider state when the chain empties", async () => {
    const prev = stateRef.current
    stateRef.current = {
      settings: {
        ...(prev.settings as Record<string, unknown>),
        providerSettings: {
          groq: { providerId: "groq", enabled: false },
          openai: { providerId: "openai", enabled: false },
        },
      },
    }
    try {
      const user = userEvent.setup()
      render(<RoutingTestPanel />)
      await user.type(screen.getByLabelText("Type an alias, e.g. fast"), "fast{Enter}")
      const banner = await screen.findByTestId("preview-no-candidates")
      expect(banner).toHaveTextContent("fast")
    } finally {
      stateRef.current = prev
    }
  })

  it("shows local calibration confidence and applies thresholds only after confirmation", async () => {
    const scores = [
      ...Array.from({ length: 20 }, (_, index) => 0.05 + index * 0.01),
      ...Array.from({ length: 20 }, (_, index) => 0.4 + index * 0.01),
      ...Array.from({ length: 20 }, (_, index) => 0.72 + index * 0.01),
    ]
    traceRows = scores.map((difficultyScore, index) => ({
      id: `span-${index}`,
      traceId: `trace-${index}`,
      spanId: `span-${index}`,
      startTime: index,
      operationName: "chat",
      providerName: "openai",
      sessionId: `session-${index}`,
      surface: "chat",
      events: [
        {
          name: "routing.plan",
          at: index,
          attributes: { decisionId: `decision-${index}`, difficultyScore },
        },
      ],
    }))

    const user = userEvent.setup()
    render(<RoutingTestPanel />)

    expect(await screen.findByTestId("routing-calibration")).toHaveTextContent(
      "Workload calibration is ready"
    )
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Apply recommendation" }))
    expect(save).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        thresholds: expect.objectContaining({
          balanced: expect.any(Number),
          powerful: expect.any(Number),
        }),
      }),
    })
  })

  it("shows the minimum-sample calibration state without offering silent changes", async () => {
    render(<RoutingTestPanel />)

    expect(await screen.findByTestId("routing-calibration")).toHaveTextContent(
      "Calibration needs at least 50 local decisions"
    )
    expect(screen.queryByRole("button", { name: "Apply recommendation" })).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it("shows the per-tier calibration state when the sample count is large but imbalanced", async () => {
    traceRows = Array.from({ length: 50 }, (_, index) => ({
      id: `span-${index}`,
      traceId: `trace-${index}`,
      spanId: `span-${index}`,
      startTime: index,
      operationName: "chat",
      providerName: "openai",
      sessionId: `session-${index}`,
      surface: "chat",
      events: [
        {
          name: "routing.plan",
          at: index,
          attributes: { decisionId: `decision-${index}`, difficultyScore: 0.1 },
        },
      ],
    }))

    render(<RoutingTestPanel />)

    expect(await screen.findByTestId("routing-calibration")).toHaveTextContent(
      "More per-tier samples are needed"
    )
    expect(screen.queryByRole("button", { name: "Apply recommendation" })).not.toBeInTheDocument()
  })

  it("fails closed when local trace loading fails", async () => {
    traceError = new Error("Dexie unavailable")
    render(<RoutingTestPanel />)

    await waitFor(() => expect(mockQueryRecent).toHaveBeenCalled())
    expect(screen.queryByTestId("routing-calibration")).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it("does not update calibration after an in-flight trace query outlives the panel", async () => {
    let resolveQuery: ((rows: AgentTraceSpan[]) => void) | undefined
    mockQueryRecent.mockReturnValueOnce(
      new Promise<AgentTraceSpan[]>((resolve) => {
        resolveQuery = resolve
      })
    )
    const view = render(<RoutingTestPanel />)
    view.unmount()

    await act(async () => {
      resolveQuery?.([])
      await Promise.resolve()
    })

    expect(screen.queryByTestId("routing-calibration")).not.toBeInTheDocument()
  })

  it("does not update calibration when an unmounted trace query rejects", async () => {
    let rejectQuery: ((error: Error) => void) | undefined
    mockQueryRecent.mockReturnValueOnce(
      new Promise<AgentTraceSpan[]>((_, reject) => {
        rejectQuery = reject
      })
    )
    const view = render(<RoutingTestPanel />)
    view.unmount()

    await act(async () => {
      rejectQuery?.(new Error("late failure"))
      await Promise.resolve()
    })

    expect(screen.queryByTestId("routing-calibration")).not.toBeInTheDocument()
  })
})
