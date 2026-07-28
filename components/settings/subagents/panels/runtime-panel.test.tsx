/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SubAgent, SubAgentStatus } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}))

const toastSuccess = jest.fn()
const toastInfo = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    error: jest.fn(),
  },
}))

const requestCancel = jest.fn()
jest.mock("@/lib/claude/agents/subagent-cancel-registry", () => ({
  requestCancelSubagentRun: (...a: unknown[]) => requestCancel(...a),
}))

let subAgents: Record<string, SubAgent> = {}
const remove = jest.fn()
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: (selector: (s: unknown) => unknown) => selector({ subAgents, remove }),
}))

import { RuntimePanel, formatDuration } from "./runtime-panel"

let seq = 0
const run = (
  id: string,
  over: Partial<SubAgent> & { parent?: string; status?: SubAgentStatus } = {}
): SubAgent =>
  ({
    id,
    parentAgentId: "chat",
    name: id,
    description: "",
    task: "",
    initialTask: "",
    threadId: id,
    status: over.status ?? "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: new Date(++seq * 10),
    lastActivityAt: new Date(seq * 10),
    retryCount: 0,
    order: 0,
    parentSubagentId: over.parent,
    ...over,
  }) as SubAgent

const seed = (...runs: SubAgent[]) => {
  subAgents = Object.fromEntries(runs.map((r) => [r.id, r]))
}

beforeEach(() => {
  jest.clearAllMocks()
  seq = 0
  subAgents = {}
})

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [850, "850ms"],
    [1500, "2s"],
    [65_000, "1m 5s"],
    [3_900_000, "1h 5m"],
    [-5, "0ms"],
  ])("formats %sms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe("empty state", () => {
  it("explains itself rather than looking broken", () => {
    render(<RuntimePanel />)
    expect(screen.getByTestId("subagent-runtime-empty")).toBeInTheDocument()
  })
})

describe("tree rendering (G4)", () => {
  it("indents a child under its parent and levels it for assistive tech", () => {
    seed(run("root", { startedAt: new Date() }), run("child", { parent: "root" }))
    render(<RuntimePanel />)
    expect(screen.getByTestId("subagent-runtime-row-root")).toHaveAttribute("data-depth", "0")
    const child = screen.getByTestId("subagent-runtime-row-child")
    expect(child).toHaveAttribute("data-depth", "1")
    expect(child).toHaveAttribute("aria-level", "2")
  })

  it("surfaces an orphaned child at the root rather than hiding it", () => {
    seed(run("orphan", { parent: "collected-already" }))
    render(<RuntimePanel />)
    expect(screen.getByTestId("subagent-runtime-row-orphan")).toHaveAttribute("data-depth", "0")
  })
})

describe("cancel (G3)", () => {
  it("offers cancel on a live run and reports success", async () => {
    requestCancel.mockReturnValue(true)
    seed(run("live", { startedAt: new Date() }))
    render(<RuntimePanel />)
    await userEvent.click(screen.getByTestId("subagent-runtime-cancel-live"))
    expect(requestCancel).toHaveBeenCalledWith("live", expect.any(String))
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("says so honestly when the run has no abort controller to signal", async () => {
    // Only `dispatch_agent` runs register one; an SDK-native Task run does not.
    // Claiming a cancel there would be a lie.
    requestCancel.mockReturnValue(false)
    seed(run("native", { startedAt: new Date() }))
    render(<RuntimePanel />)
    await userEvent.click(screen.getByTestId("subagent-runtime-cancel-native"))
    expect(toastInfo).toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("shows remove instead of cancel once a run has settled", () => {
    seed(run("done", { status: "completed" }))
    render(<RuntimePanel />)
    expect(screen.queryByTestId("subagent-runtime-cancel-done")).not.toBeInTheDocument()
    expect(screen.getByTestId("subagent-runtime-remove-done")).toBeInTheDocument()
  })
})

describe("clearing", () => {
  it("clears only the settled runs and never the live ones", async () => {
    seed(
      run("live", { startedAt: new Date() }),
      run("done", { status: "completed" }),
      run("bad", { status: "failed" })
    )
    render(<RuntimePanel />)
    await userEvent.click(screen.getByTestId("subagent-runtime-clear-finished"))
    expect(remove).toHaveBeenCalledTimes(2)
    expect(remove.mock.calls.flat()).toEqual(["done", "bad"])
  })

  it("hides the clear action when nothing has settled", () => {
    seed(run("live", { startedAt: new Date() }))
    render(<RuntimePanel />)
    expect(screen.queryByTestId("subagent-runtime-clear-finished")).not.toBeInTheDocument()
  })
})

describe("run detail", () => {
  it("shows the honest tool-use count", () => {
    seed(run("a", { toolUses: 4, startedAt: new Date() }))
    render(<RuntimePanel />)
    expect(screen.getByTestId("subagent-runtime-tools-a")).toBeInTheDocument()
  })

  it("renders the token counter only when usage has arrived", () => {
    seed(run("a", { startedAt: new Date() }))
    const { rerender } = render(<RuntimePanel />)
    expect(screen.queryByTestId("subagent-runtime-tokens-a")).not.toBeInTheDocument()

    seed(
      run("a", {
        startedAt: new Date(),
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
    )
    rerender(<RuntimePanel />)
    expect(screen.getByTestId("subagent-runtime-tokens-a")).toBeInTheDocument()
  })

  it("surfaces a nesting-guard rejection", () => {
    seed(
      run("blocked", {
        status: "rejected",
        rejection: { reason: "max-depth", message: "too deep" },
      })
    )
    render(<RuntimePanel />)
    expect(screen.getByTestId("rejection-blocked")).toHaveTextContent("too deep")
  })
})
