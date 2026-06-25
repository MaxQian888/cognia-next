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

jest.mock("@/hooks/use-platform", () => ({
  usePlatform: jest.fn(() => "web"),
}))
import { usePlatform } from "@/hooks/use-platform"

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
    expect(screen.getByText("Bash: npm test")).toBeInTheDocument()
  })

  it("surfaces the steer queue chip with its depth and a preview", () => {
    seed({ status: "streaming", steerQueue: [{ id: "e1", text: "fix the   failing test" }] })
    render(<RunStatusBar sessionId={SID} />)
    // identity mock echoes the count payload
    expect(screen.getByTestId("run-status-steer-chip").textContent).toContain('queued:{"count":1}')
    expect(screen.getByText("• fix the failing test")).toBeInTheDocument()
  })

  it("shows a 📎 attachment count on a queued steer that carries blocks", () => {
    seed({
      status: "streaming",
      steerQueue: [
        {
          id: "img",
          text: "look at this",
          blocks: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText("×1")).toBeInTheDocument()
  })

  it("removes a queued entry via its × control", () => {
    seed({
      status: "streaming",
      steerQueue: [
        { id: "a", text: "alpha" },
        { id: "b", text: "beta" },
      ],
    })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText("• alpha")).toBeInTheDocument()
    // ariaRemoveSteer is echoed by the identity i18n mock.
    fireEvent.click(screen.getAllByLabelText("ariaRemoveSteer")[0])
    expect(screen.queryByText("• alpha")).not.toBeInTheDocument()
    expect(screen.getByText("• beta")).toBeInTheDocument()
  })

  it("inline-edits a queued entry and commits on Enter", () => {
    seed({ status: "streaming", steerQueue: [{ id: "a", text: "old" }] })
    render(<RunStatusBar sessionId={SID} />)
    fireEvent.click(screen.getByText("• old"))
    const input = screen.getByTestId("run-panel-steer-edit") as HTMLInputElement
    fireEvent.change(input, { target: { value: "new text" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByText("• new text")).toBeInTheDocument()
    expect(useChatStore.getState().sessions[SID]?.steerQueue[0]?.text).toBe("new text")
  })

  it("emptying an entry in the editor removes it", () => {
    seed({ status: "streaming", steerQueue: [{ id: "a", text: "old" }] })
    render(<RunStatusBar sessionId={SID} />)
    fireEvent.click(screen.getByText("• old"))
    const input = screen.getByTestId("run-panel-steer-edit") as HTMLInputElement
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(useChatStore.getState().sessions[SID]?.steerQueue).toEqual([])
  })

  it("surfaces a stuck-queue header after an errored settle with flush + discard", async () => {
    const onSteerFlush = jest.fn()
    seed({ status: "error", steerQueue: [{ id: "a", text: "retry this" }] })
    render(<RunStatusBar sessionId={SID} onSteerFlush={onSteerFlush} />)
    expect(screen.getByTestId("run-panel-stuck-queue").textContent).toContain(
      'runFailedQueued:{"count":1}'
    )
    fireEvent.click(screen.getByText("steerNow"))
    await waitFor(() => expect(onSteerFlush).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText("discardQueue"))
    expect(useChatStore.getState().sessions[SID]?.steerQueue).toEqual([])
  })

  it("interrupt hint triggers onStop", () => {
    const onStop = jest.fn()
    seed({ status: "streaming" })
    render(<RunStatusBar sessionId={SID} onStop={onStop} />)
    fireEvent.click(screen.getByText("interruptHint"))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("uses touch-appropriate interrupt copy on the Capacitor native shell", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    try {
      seed({ status: "streaming" })
      render(<RunStatusBar sessionId={SID} onStop={jest.fn()} />)
      expect(screen.getByText("interruptHintTouch")).toBeInTheDocument()
      expect(screen.queryByText("interruptHint")).not.toBeInTheDocument()
    } finally {
      ;(usePlatform as jest.Mock).mockReturnValue("web")
    }
  })

  it('"Send now" triggers onSteerNow only when a steer is queued and busy', async () => {
    const onSteerNow = jest.fn()
    seed({ status: "streaming", steerQueue: [{ id: "x", text: "do X" }] })
    render(<RunStatusBar sessionId={SID} onSteerNow={onSteerNow} />)
    fireEvent.click(screen.getByText("steerNow"))
    await waitFor(() => expect(onSteerNow).toHaveBeenCalledTimes(1))
  })

  it("does not show the busy interrupt-and-send affordance when idle", () => {
    // Idle + leftover queue surfaces the stuck-queue header (discard always
    // shown); without onSteerFlush there is no flush button.
    seed({ status: "idle", steerQueue: [{ id: "o", text: "orphan" }] })
    render(<RunStatusBar sessionId={SID} onSteerNow={jest.fn()} />)
    expect(screen.queryByText("steerNow")).not.toBeInTheDocument()
    expect(screen.getByText("• orphan")).toBeInTheDocument()
    expect(screen.getByText("discardQueue")).toBeInTheDocument()
  })

  it("shows a running-subagent chip while streaming", () => {
    useSubagentRuntimeStore.setState({
      subAgents: {
        z: { name: "reviewer", status: "running" } as never,
      },
    })
    seed({ status: "streaming" })
    render(<RunStatusBar sessionId={SID} />)
    expect(screen.getByText(/reviewer/)).toBeInTheDocument()
  })
})
