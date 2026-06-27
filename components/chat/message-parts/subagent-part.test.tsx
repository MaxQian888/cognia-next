/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { SubagentPart } from "./subagent-part"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubagentPart as SubagentPartType } from "@/lib/claude/parts-extensions"
import type { SubAgent } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Stub Collapsible primitives so children always render in tests.
jest.mock("@/components/ui/collapsible")

// MarkdownRenderer pulls in ESM (streamdown/shiki) — stub it.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="subagent-md">{content}</div>
  ),
}))
// Inline tool list children — assert via entry counts, not their internals.
jest.mock("@/components/chat/message-parts/tool-activity-group", () => ({
  ToolActivityGroup: ({ entries }: { entries: unknown[] }) => (
    <div data-testid="tool-activity-group" data-count={entries.length} />
  ),
}))
jest.mock("@/components/chat/message-parts/tool-call-row", () => ({
  ToolCallRow: () => <div data-testid="tool-call-row" />,
}))

const cancelSubagentRun = jest.fn()
jest.mock("@/lib/claude/agents/cancel-subagent", () => ({
  cancelSubagentRun: (...a: unknown[]) => cancelSubagentRun(...a),
}))

const basePart: SubagentPartType = {
  type: "subagent",
  subagentId: "sa-1",
  parentSessionId: "p1",
  name: "Researcher",
  status: "running",
  progress: 33,
  startedAt: Date.now() - 5000,
}

function makeSubAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: "sa-1",
    parentAgentId: "p1",
    name: "Researcher",
    description: "",
    task: "search",
    initialTask: "search",
    threadId: "t",
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 33,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    retryCount: 0,
    order: 0,
    ...overrides,
  }
}

beforeEach(() => {
  useSubagentRuntimeStore.setState((s) => ({ ...s, subAgents: {} }))
  cancelSubagentRun.mockClear()
})

describe("SubagentPart", () => {
  it("renders the static snapshot when no live entry is in the store", () => {
    render(<SubagentPart part={basePart} />)
    const root = screen.getByTestId("subagent-part-sa-1")
    expect(root.dataset.status).toBe("running")
    expect(screen.getByText("Researcher")).toBeInTheDocument()
  })

  it("uses the live store value for status + progress when present", () => {
    useSubagentRuntimeStore.getState().upsert(makeSubAgent({ status: "completed", progress: 100 }))
    render(<SubagentPart part={basePart} />)
    expect(screen.getByTestId("subagent-part-sa-1").dataset.status).toBe("completed")
    expect(screen.getByTestId("subagent-status-badge").textContent).toMatch(/completed/)
  })

  it("renders the latest logs when the store has them", () => {
    useSubagentRuntimeStore.getState().upsert(
      makeSubAgent({
        logs: [{ timestamp: new Date(), level: "info", message: "tool ran" }],
      })
    )
    render(<SubagentPart part={basePart} />)
    expect(screen.getByText(/tool ran/)).toBeInTheDocument()
  })

  it("renders the noLogsYet placeholder when neither store nor part has logs", () => {
    render(<SubagentPart part={basePart} />)
    expect(screen.getByText("noLogsYet")).toBeInTheDocument()
  })

  it("shows the honest tool-use count while running (no progress bar)", () => {
    useSubagentRuntimeStore.getState().upsert(makeSubAgent({ status: "running", toolUses: 4 }))
    render(<SubagentPart part={basePart} />)
    expect(screen.getByTestId("subagent-tools-count").textContent).toContain('"n":4')
    // The old determinate progress bar must be gone.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("shows the tool-use count in simplified mode too", () => {
    useSubagentRuntimeStore.getState().upsert(makeSubAgent({ status: "running", toolUses: 2 }))
    render(<SubagentPart part={basePart} mode="simplified" />)
    expect(screen.getByTestId("subagent-tools-count").textContent).toContain('"n":2')
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("hides the tool-use count once the run is no longer running", () => {
    useSubagentRuntimeStore
      .getState()
      .upsert(makeSubAgent({ status: "completed", toolUses: 9, completedAt: new Date() }))
    render(<SubagentPart part={{ ...basePart, completedAt: Date.now() }} />)
    expect(screen.queryByTestId("subagent-tools-count")).not.toBeInTheDocument()
  })

  it("omits the tool-use count when running but no tools have run yet", () => {
    useSubagentRuntimeStore.getState().upsert(makeSubAgent({ status: "running", toolUses: 0 }))
    render(<SubagentPart part={basePart} />)
    expect(screen.queryByTestId("subagent-tools-count")).not.toBeInTheDocument()
  })

  it("renders an Open-in-workspace link with the subagent id encoded", () => {
    render(<SubagentPart part={basePart} />)
    const link = screen.getByTestId("subagent-open") as HTMLAnchorElement
    expect(link.getAttribute("href")).toContain("subagent:sa-1")
  })

  it("computes duration from startedAt → completedAt when both present", () => {
    const partCompleted: SubagentPartType = {
      ...basePart,
      startedAt: 1000,
      completedAt: 2500,
      status: "completed",
    }
    render(<SubagentPart part={partCompleted} />)
    // durationMs i18n: durationMs:{"ms":1500}
    expect(screen.getByText(/durationMs:.*1500/)).toBeInTheDocument()
  })

  it("toggle button is keyboard activatable (clickable)", () => {
    render(<SubagentPart part={basePart} />)
    const toggle = screen.getByTestId("subagent-toggle-sa-1")
    fireEvent.click(toggle)
    // Stub Collapsible always shows children; just verify the click doesn't crash.
    expect(toggle).toBeInTheDocument()
  })

  it("shows a depth badge when depth is set", () => {
    render(<SubagentPart part={{ ...basePart, depth: 2 }} />)
    expect(screen.getByTestId("subagent-depth-badge").textContent).toMatch(/depthBadge.*2/)
  })

  it("renders a max-depth rejection banner", () => {
    render(
      <SubagentPart
        part={{
          ...basePart,
          status: "rejected",
          completedAt: basePart.startedAt + 1,
          rejection: { reason: "max-depth", message: "nope" },
        }}
      />
    )
    expect(screen.getByTestId("subagent-rejection").textContent).toBe("rejected.maxDepth")
  })

  it("renders a cycle rejection banner", () => {
    render(
      <SubagentPart
        part={{
          ...basePart,
          status: "rejected",
          completedAt: basePart.startedAt + 1,
          rejection: { reason: "cycle", message: "x" },
        }}
      />
    )
    expect(screen.getByTestId("subagent-rejection").textContent).toBe("rejected.cycle")
  })

  it("shows a background badge while a backgrounded run is running", () => {
    render(<SubagentPart part={{ ...basePart, backgrounded: true, status: "running" }} />)
    expect(screen.getByTestId("subagent-background-badge")).toBeInTheDocument()
  })

  it("clears the background badge once the live store completes the run", () => {
    useSubagentRuntimeStore
      .getState()
      .upsert(makeSubAgent({ status: "completed", backgrounded: false }))
    render(<SubagentPart part={{ ...basePart, backgrounded: true }} />)
    expect(screen.queryByTestId("subagent-background-badge")).toBeNull()
  })

  it("shows a token badge from the part snapshot", () => {
    render(
      <SubagentPart
        part={{
          ...basePart,
          tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }}
      />
    )
    expect(screen.getByTestId("subagent-tokens-badge").textContent).toMatch(/15/)
  })

  describe("inline tool list + result + abort (Part 2)", () => {
    it("renders a grouped tool activity when ≥2 tool calls (detailed/open)", () => {
      useSubagentRuntimeStore.getState().upsert(
        makeSubAgent({
          toolCalls: [
            { id: "t1", name: "read", state: "done" },
            { id: "t2", name: "grep", state: "running" },
          ],
        })
      )
      render(<SubagentPart part={basePart} mode="detailed" />)
      expect(screen.getByTestId("tool-activity-group").getAttribute("data-count")).toBe("2")
    })

    it("renders a single tool row when exactly one tool call", () => {
      useSubagentRuntimeStore
        .getState()
        .upsert(makeSubAgent({ toolCalls: [{ id: "t1", name: "read", state: "running" }] }))
      render(<SubagentPart part={basePart} mode="detailed" />)
      expect(screen.getByTestId("tool-call-row")).toBeInTheDocument()
    })

    it("renders the final output as markdown when the run has a result", () => {
      useSubagentRuntimeStore.getState().upsert(
        makeSubAgent({
          status: "completed",
          completedAt: new Date(),
          result: {
            success: true,
            finalResponse: "# Done",
            steps: [],
            totalSteps: 0,
            duration: 1,
          },
        })
      )
      render(<SubagentPart part={{ ...basePart, completedAt: Date.now() }} mode="detailed" />)
      expect(screen.getByTestId("subagent-result")).toBeInTheDocument()
      expect(screen.getByTestId("subagent-md").textContent).toBe("# Done")
    })

    it("renders a token breakdown from the run result", () => {
      useSubagentRuntimeStore.getState().upsert(
        makeSubAgent({
          status: "completed",
          completedAt: new Date(),
          result: {
            success: true,
            finalResponse: "ok",
            steps: [],
            totalSteps: 0,
            duration: 1,
            tokenUsage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
          },
        })
      )
      render(<SubagentPart part={{ ...basePart, completedAt: Date.now() }} mode="detailed" />)
      expect(screen.getByTestId("subagent-tokens-breakdown").textContent).toContain('"total":42')
    })

    it("shows an Abort button while running and calls cancelSubagentRun", () => {
      useSubagentRuntimeStore.getState().upsert(makeSubAgent({ status: "running" }))
      render(<SubagentPart part={basePart} mode="standard" />)
      const abort = screen.getByTestId("subagent-abort-sa-1")
      fireEvent.click(abort)
      expect(cancelSubagentRun).toHaveBeenCalledWith("sa-1", { backgrounded: false })
    })

    it("hides the Abort button once the run is no longer running", () => {
      useSubagentRuntimeStore
        .getState()
        .upsert(makeSubAgent({ status: "completed", completedAt: new Date() }))
      render(<SubagentPart part={{ ...basePart, completedAt: Date.now() }} />)
      expect(screen.queryByTestId("subagent-abort-sa-1")).toBeNull()
    })

    it("passes backgrounded:true to cancel for a backgrounded run", () => {
      useSubagentRuntimeStore
        .getState()
        .upsert(makeSubAgent({ status: "running", backgrounded: true }))
      render(<SubagentPart part={{ ...basePart, backgrounded: true }} mode="simplified" />)
      fireEvent.click(screen.getByTestId("subagent-abort-sa-1"))
      expect(cancelSubagentRun).toHaveBeenCalledWith("sa-1", { backgrounded: true })
    })
  })

  describe("mode + controlled open", () => {
    it("detailed mode opens the card by default (data-open on Collapsible)", () => {
      const { container } = render(<SubagentPart part={basePart} mode="detailed" />)
      expect(container.querySelector('[data-open="true"]')).not.toBeNull()
    })

    it("standard mode keeps the card collapsed by default", () => {
      const { container } = render(<SubagentPart part={basePart} mode="standard" />)
      expect(container.querySelector('[data-open="true"]')).toBeNull()
    })

    it("uncontrolled card toggles its own open state on click", () => {
      const { container } = render(<SubagentPart part={basePart} mode="standard" />)
      fireEvent.click(screen.getByTestId("subagent-toggle-sa-1"))
      expect(container.querySelector('[data-open="true"]')).not.toBeNull()
    })

    it("controlled card defers open state + toggle to the parent", () => {
      const onToggle = jest.fn()
      const { container, rerender } = render(
        <SubagentPart part={basePart} mode="standard" open={false} onToggle={onToggle} />
      )
      expect(container.querySelector('[data-open="true"]')).toBeNull()
      fireEvent.click(screen.getByTestId("subagent-toggle-sa-1"))
      expect(onToggle).toHaveBeenCalledTimes(1)
      // Parent flips the prop — the card reflects it without internal state.
      rerender(<SubagentPart part={basePart} mode="standard" open onToggle={onToggle} />)
      expect(container.querySelector('[data-open="true"]')).not.toBeNull()
    })
  })

  describe("simplified row", () => {
    it("renders a compact row that hides the detail until expanded", () => {
      useSubagentRuntimeStore
        .getState()
        .upsert(
          makeSubAgent({ logs: [{ timestamp: new Date(), level: "info", message: "tool ran" }] })
        )
      render(<SubagentPart part={basePart} mode="simplified" />)
      const toggle = screen.getByTestId("subagent-toggle-sa-1")
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      // Collapsed: the workspace link (detail-only) is not rendered yet.
      expect(screen.queryByTestId("subagent-open")).toBeNull()
      fireEvent.click(toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      expect(screen.getByTestId("subagent-open")).toBeInTheDocument()
      expect(screen.getByTestId("subagent-logs")).toBeInTheDocument()
    })

    it("exposes a descriptive aria-label and screen-reader status", () => {
      render(<SubagentPart part={basePart} mode="simplified" />)
      expect(screen.getByTestId("subagent-toggle-sa-1").getAttribute("aria-label")).toMatch(
        /rowAria.*Researcher/
      )
    })

    it("shows the rejection banner inline even while collapsed", () => {
      render(
        <SubagentPart
          part={{
            ...basePart,
            status: "rejected",
            completedAt: basePart.startedAt + 1,
            rejection: { reason: "cycle", message: "x" },
          }}
          mode="simplified"
        />
      )
      expect(screen.getByTestId("subagent-rejection").textContent).toBe("rejected.cycle")
    })

    it("renders the noLogsYet placeholder when expanded with no logs", () => {
      render(<SubagentPart part={basePart} mode="simplified" open onToggle={() => {}} />)
      expect(screen.getByText("noLogsYet")).toBeInTheDocument()
    })

    it("shows the background badge in the row while backgrounded + running", () => {
      render(
        <SubagentPart
          part={{ ...basePart, backgrounded: true, status: "running" }}
          mode="simplified"
        />
      )
      expect(screen.getByTestId("subagent-background-badge")).toBeInTheDocument()
    })

    it("renders depth + token badges in the row", () => {
      render(
        <SubagentPart
          part={{
            ...basePart,
            depth: 2,
            tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 9 },
          }}
          mode="simplified"
        />
      )
      expect(screen.getByTestId("subagent-depth-badge")).toBeInTheDocument()
      expect(screen.getByTestId("subagent-tokens-badge").textContent).toMatch(/9/)
    })
  })
})
