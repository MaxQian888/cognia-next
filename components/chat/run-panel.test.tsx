/**
 * @jest-environment jsdom
 */
import { act, render, screen, fireEvent } from "@testing-library/react"
import type { UIMessage } from "ai"

import { RunPanel } from "./run-panel"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useSettingsStore } from "@/stores/settings"

// Identity i18n with var echo.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Stub the heavy reused renderers — they have their own suites.
jest.mock("./message-parts/tool-call-row", () => ({
  ToolCallRow: ({ part }: { part: { type: string } }) => (
    <div data-testid="tool-row" data-tool={part.type} />
  ),
}))
jest.mock("./message-parts/subagent-tree", () => ({
  SubagentTree: ({ parts }: { parts: unknown[] }) => (
    <div data-testid="subagent-tree" data-count={parts.length} />
  ),
}))

const SID = "s1"

function seed(slice: Partial<SessionChatSlice>) {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: { [SID]: { ...makeSessionSlice(), ...slice } },
  })
}

function assistant(parts: unknown[]): UIMessage {
  return { id: "a1", role: "assistant", parts } as unknown as UIMessage
}

function toolPart(toolCallId: string, name: string, state: string, input: unknown = {}) {
  return { type: `tool-${name}`, state, input, toolCallId }
}

function todoPart(todos: unknown[]) {
  return { type: "tool-TodoWrite", state: "output-available", input: { todos }, toolCallId: "td" }
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  useSubagentRuntimeStore.setState({ subAgents: {} })
})

describe("RunPanel — expansion", () => {
  it("shows an expand toggle only when the turn has work", () => {
    seed({ status: "streaming", messages: [] })
    const { rerender } = render(<RunPanel sessionId={SID} />)
    expect(screen.queryByTestId("run-panel-toggle")).not.toBeInTheDocument()

    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    rerender(<RunPanel sessionId={SID} key="2" />)
    expect(screen.getByTestId("run-panel-toggle")).toBeInTheDocument()
  })

  it("reveals the Tools section with a row per tool when expanded", () => {
    seed({
      status: "streaming",
      messages: [
        assistant([
          toolPart("t1", "Read", "output-available", { file_path: "/a" }),
          toolPart("t2", "Bash", "input-available", { command: "ls" }),
        ]),
      ],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.queryByTestId("run-panel-body")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByTestId("run-panel-body")).toBeInTheDocument()
    expect(screen.getAllByTestId("tool-row")).toHaveLength(2)
  })

  it("renders per-tool elapsed from the timestamp map", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Read", "output-available", { file_path: "/a" })])],
      toolTimestamps: { t1: { startedAt: 1000, endedAt: 4000 } },
    })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByText("3s")).toBeInTheDocument()
  })

  it("renders the Plan section from a TodoWrite snapshot", () => {
    seed({
      status: "streaming",
      messages: [assistant([todoPart([{ content: "do the thing", status: "pending" }])])],
    })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByText("do the thing")).toBeInTheDocument()
  })

  it("renders the Sub-agents section from subagent parts", () => {
    const sub = {
      type: "subagent",
      subagentId: "sa1",
      parentSessionId: SID,
      name: "reviewer",
      status: "running",
      progress: 0,
      startedAt: 1,
    }
    seed({ status: "streaming", messages: [assistant([sub])] })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByTestId("subagent-tree")).toBeInTheDocument()
  })
})

describe("RunPanel — idle replay", () => {
  it("shows a Last-run bar when idle with a settled record", () => {
    seed({
      status: "idle",
      messages: [assistant([toolPart("t1", "Read", "output-available", { file_path: "/a" })])],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-panel-replay-summary")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("run-panel-toggle"))
    expect(screen.getByTestId("run-panel-body")).toBeInTheDocument()
  })

  it("reports a reloaded turn's duration from its persisted timestamps, never 0s", () => {
    // After a reload the live clock is idle and was never persisted; the
    // turn's own run stamp is what still knows it took minutes.
    seed({
      status: "idle",
      messages: [
        { id: "u1", role: "user", parts: [], metadata: { createdAt: 1_000 } },
        {
          ...assistant(
            Array.from({ length: 11 }, (_, i) => toolPart(`t${i}`, "Read", "output-available"))
          ),
          metadata: { createdAt: 2_000, run: { startedAt: 1_000, completedAt: 185_000 } },
        },
      ] as unknown as UIMessage[],
    })
    render(<RunPanel sessionId={SID} />)
    const summary = screen.getByTestId("run-panel-replay-summary")
    expect(summary).toHaveTextContent('lastRunSummary:{"count":11,"elapsed":"3m 04s"}')
    expect(summary).not.toHaveTextContent('"0s"')
  })

  it("omits the duration when nothing recorded how long the turn took", () => {
    seed({
      status: "idle",
      messages: [assistant([toolPart("t1", "Read", "output-available", { file_path: "/a" })])],
    })
    render(<RunPanel sessionId={SID} />)
    const summary = screen.getByTestId("run-panel-replay-summary")
    expect(summary).toHaveTextContent('summaryTools:{"count":1}')
    expect(summary).not.toHaveTextContent("lastRunSummary")
    expect(summary).not.toHaveTextContent("0s")
  })

  it("banks the live clock when the turn settles, so the summary matches the ticker", () => {
    const messages = [assistant([toolPart("t1", "Bash", "output-available")])]
    seed({
      status: "streaming",
      runId: 4,
      messages,
      runTiming: { startedAt: 10_000, pausedAt: null, pausedAccumMs: 5_000 },
    })
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(135_000)
    try {
      render(<RunPanel sessionId={SID} />)
      // The turn settles: the store resets the clock to idle in the same write.
      act(() => {
        useChatStore.setState((state) => ({
          sessions: {
            [SID]: {
              ...state.sessions[SID]!,
              status: "idle",
              runTiming: { startedAt: null, pausedAt: null, pausedAccumMs: 0 },
            },
          },
        }))
      })
      // 135s − 10s − 5s of approval wait = 2m 00s of active work.
      expect(screen.getByTestId("run-panel-replay-summary")).toHaveTextContent(
        'lastRunSummary:{"count":1,"elapsed":"2m 00s"}'
      )
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("renders nothing when idle with no work and no queue", () => {
    seed({ status: "idle", messages: [] })
    const { container } = render(<RunPanel sessionId={SID} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("RunPanel — metric strip", () => {
  function assistantWithUsage(usage: Record<string, number>): UIMessage {
    return {
      id: "a1",
      role: "assistant",
      parts: [toolPart("t1", "Bash", "output-available")],
      metadata: { usage },
    } as unknown as UIMessage
  }

  it("renders output-token + speed chips from live usage under the default config", () => {
    // No settings mock → runStatusBar undefined → defaults (tokens + speed on,
    // cost + context off). 500 output tok over 10s → 50 tok/s.
    seed({
      status: "streaming",
      messages: [
        assistantWithUsage({
          inputTokens: 100,
          outputTokens: 500,
          durationMs: 10_000,
          totalCostUsd: 0.03,
        }),
      ],
    })
    render(<RunPanel sessionId={SID} />)
    const strip = screen.getByTestId("run-bar-metrics")
    expect(strip).toHaveTextContent("metricTokens") // "{value} tok"
    expect(strip).toHaveTextContent("metricSpeed") // "{value} tok/s"
    // Cost + context are opt-in; the currency symbol / context key stay hidden.
    expect(strip).not.toHaveTextContent("metricContext")
  })

  it("refreshes the chips when a new usage-bearing turn lands (signature-gated aggregate)", () => {
    seed({
      status: "streaming",
      messages: [assistantWithUsage({ inputTokens: 100, outputTokens: 500, durationMs: 10_000 })],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-bar-metrics")).toHaveTextContent('metricTokens:{"value":"500"}')
    // A second usage-bearing assistant lands → the O(n) aggregate re-runs
    // (message count moved) and the token chip reflects the new total.
    act(() => {
      seed({
        status: "streaming",
        messages: [
          assistantWithUsage({ inputTokens: 100, outputTokens: 500, durationMs: 10_000 }),
          {
            id: "a2",
            role: "assistant",
            parts: [toolPart("t2", "Bash", "output-available")],
            metadata: { usage: { inputTokens: 50, outputTokens: 300, durationMs: 5_000 } },
          } as unknown as UIMessage,
        ],
      })
    })
    expect(screen.getByTestId("run-bar-metrics")).toHaveTextContent('metricTokens:{"value":"800"}')
  })

  it("hides the usage row entirely when no turn carries usage", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    render(<RunPanel sessionId={SID} />)
    // The tool count rides the summary line now, so with no usage there is no
    // second row at all.
    expect(screen.queryByTestId("run-bar-metrics")).not.toBeInTheDocument()
  })
})

describe("RunPanel — accessibility", () => {
  it("sets aria-atomic false and makes the summary line a labelled disclosure", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-status-bar")).toHaveAttribute("aria-atomic", "false")
    const toggle = screen.getByTestId("run-panel-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveAttribute("aria-controls", "run-panel-body")
    expect(toggle).toHaveTextContent("expand")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("collapse")
  })
})

describe("RunPanel — summary line", () => {
  it("shows state, elapsed time, tool count and the newest running tool on one line", () => {
    seed({
      status: "streaming",
      runTiming: { startedAt: Date.now() - 60_000, pausedAt: null, pausedAccumMs: 0 },
      messages: [
        assistant([
          toolPart("t1", "Read", "output-available", { file_path: "/a" }),
          toolPart("t2", "Bash", "input-available", { command: "ls" }),
        ]),
      ],
    })
    render(<RunPanel sessionId={SID} />)
    const line = screen.getByTestId("run-panel-toggle")
    expect(line).toHaveTextContent("working")
    expect(line).toContainElement(screen.getByTestId("run-status-elapsed"))
    expect(screen.getByTestId("run-status-elapsed").textContent).toMatch(/1m/)
    expect(screen.getByTestId("run-status-tools")).toHaveTextContent('summaryTools:{"count":2}')
    expect(screen.getByTestId("run-status-current-tool")).toHaveTextContent("Bash: ls")
  })

  it("collapses parallel running tools to the newest plus a count", () => {
    seed({
      status: "streaming",
      messages: [
        assistant([
          toolPart("t1", "Bash", "input-available", { command: "a" }),
          toolPart("t2", "Bash", "input-available", { command: "b" }),
          toolPart("t3", "Bash", "input-available", { command: "c" }),
        ]),
      ],
    })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-status-current-tool")).toHaveTextContent("Bash: c")
    expect(screen.getByTestId("run-panel-toggle")).toHaveTextContent("+2")
  })

  it("leaves the tool count out when the setting turns it off", () => {
    useSettingsStore.setState({ settings: { runStatusBar: { showTools: false } } as never })
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    const { unmount } = render(<RunPanel sessionId={SID} />)
    expect(screen.queryByTestId("run-status-tools")).not.toBeInTheDocument()
    unmount()
    useSettingsStore.setState({ settings: undefined as never })
  })
})

describe("RunPanel — no interrupt affordance", () => {
  // Interrupting moved to the composer's Stop button (and Esc in the
  // textarea). A tap on the strip — the whole of it — only opens the details.
  it("offers no interrupt control or hint on the strip", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    render(<RunPanel sessionId={SID} />)
    const strip = screen.getByTestId("run-status-bar")
    expect(strip).not.toHaveTextContent(/interrupt/i)
    expect(screen.queryByLabelText(/interrupt/i)).not.toBeInTheDocument()
    // Every button on a busy strip with no queue is the disclosure.
    expect(screen.getAllByRole("button")).toEqual([screen.getByTestId("run-panel-toggle")])
  })

  it("expands instead of interrupting when the summary line is tapped", () => {
    seed({
      status: "streaming",
      messages: [assistant([toolPart("t1", "Bash", "input-available")])],
    })
    render(<RunPanel sessionId={SID} />)
    fireEvent.click(screen.getByText("working"))
    expect(screen.getByTestId("run-panel-body")).toBeInTheDocument()
    // Still running: nothing the tap did ended the turn.
    expect(useChatStore.getState().sessions[SID]?.status).toBe("streaming")
  })

  it("renders a busy strip with no tools as plain text, nothing to tap", () => {
    seed({ status: "streaming", messages: [] })
    render(<RunPanel sessionId={SID} />)
    expect(screen.getByTestId("run-status-bar")).toHaveTextContent("working")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
