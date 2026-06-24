/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

import { RunStatusBar } from "./run-status-bar"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

// Identity i18n with var echo (so we can assert the `{count}` payload).
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const SID = "s1"

function seed(slice: Partial<SessionChatSlice>) {
  useChatStore.setState({
    activeSessionId: SID,
    sessions: { [SID]: { ...makeSessionSlice(), ...slice } },
  })
}

function assistantWithRunningTool(): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-Bash",
        state: "input-available",
        input: { command: "npm test" },
        toolCallId: "t1",
      },
    ],
  } as unknown as UIMessage
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: {} })
  useSubagentRuntimeStore.setState({ subAgents: {} })
})

describe("RunStatusBar", () => {
  it("renders nothing when idle with no queued steer", () => {
    seed({ status: "idle", steerQueue: [] })
    const { container } = render(<RunStatusBar sessionId={SID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the working verb and an active elapsed timer while streaming", () => {
    seed({
      status: "streaming",
      runTiming: { startedAt: Date.now() - 5000, pausedAt: null, pausedAccumMs: 0 },
    })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText("working")).toBeInTheDocument()
    expect(screen.getByTestId("run-status-elapsed").textContent).toMatch(/\d+s/)
  })

  it("shows the waiting-approval verb while awaiting approval", () => {
    seed({ status: "awaiting_approval" })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText("waitingApproval")).toBeInTheDocument()
  })

  it("lists the running tool detail line", () => {
    seed({ status: "streaming", messages: [assistantWithRunningTool()] })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText("└ Bash: npm test")).toBeInTheDocument()
  })

  it("surfaces the steer queue chip with its depth and a preview", () => {
    seed({ status: "streaming", steerQueue: ["fix the   failing test"] })
    render(<RunStatusBar sessionId={SID} />)
    // identity mock echoes the count payload
    expect(screen.getByTestId("run-status-steer-chip").textContent).toContain('queued:{"count":1}')
    expect(screen.getByText("• fix the failing test")).toBeInTheDocument()
  })

  it("interrupt hint triggers onStop", () => {
    const onStop = jest.fn()
    seed({ status: "streaming" })
    render(<RunStatusBar sessionId={SID} onStop={onStop} />)
    fireEvent.click(screen.getByText("interruptHint"))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('"Send now" triggers onSteerNow only when a steer is queued and busy', async () => {
    const onSteerNow = jest.fn()
    seed({ status: "streaming", steerQueue: ["do X"] })
    render(<RunStatusBar sessionId={SID} onSteerNow={onSteerNow} />)
    fireEvent.click(screen.getByText("steerNow"))
    await waitFor(() => expect(onSteerNow).toHaveBeenCalledTimes(1))
  })

  it("hides Send now when idle even with a leftover queue", () => {
    seed({ status: "idle", steerQueue: ["orphan"] })
    render(<RunStatusBar sessionId={SID} onSteerNow={jest.fn()} />)
    // chip + preview still show, but no interrupt-and-send affordance while idle
    expect(screen.queryByText("steerNow")).not.toBeInTheDocument()
    expect(screen.getByText("• orphan")).toBeInTheDocument()
  })

  it("shows a running-subagent chip while streaming", () => {
    useSubagentRuntimeStore.setState({
      subAgents: {
        z: { name: "reviewer", status: "running" } as never,
      },
    })
    seed({ status: "streaming" })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText(/◆\s*reviewer/)).toBeInTheDocument()
  })
})
