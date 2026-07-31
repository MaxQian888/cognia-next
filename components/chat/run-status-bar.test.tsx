/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

import { RunStatusBar } from "./run-status-bar"
import { useChatStore, makeSessionSlice, type SessionChatSlice } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useSettingsStore } from "@/stores/settings"

// `save` persists to Dexie; the panel only needs it to record the one-time
// interrupt confirmation, so stub it and assert the patch.
const saveSettingsMock = jest.fn(() => Promise.resolve())

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
  useChatViewportStore.setState({ jumpToMessage: null })
  saveSettingsMock.mockClear()
  useSettingsStore.setState({ settings: {} as never, save: saveSettingsMock as never })
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

  it("reports the pending-steer depth without restating the messages", () => {
    seed({ status: "streaming", steerQueue: [{ id: "e1", text: "fix the failing test" }] })
    render(<RunStatusBar sessionId={SID} />)
    // identity mock echoes the count payload
    expect(screen.getByTestId("run-status-steer-chip").textContent).toContain('queued:{"count":1}')
    // The text itself lives on the transcript bubble — duplicating it here
    // would mean two editable copies of one message.
    expect(screen.queryByText(/fix the failing test/)).not.toBeInTheDocument()
  })

  it("jumps to the first undelivered steer message when the chip is pressed", () => {
    const jumpToMessage = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage })
    seed({
      status: "streaming",
      steerQueue: [{ id: "e1", text: "later one" }],
      messages: [
        { id: "m0", role: "user", parts: [] } as unknown as UIMessage,
        {
          id: "m-e1",
          role: "user",
          parts: [{ type: "text", text: "later one" }],
          metadata: { steer: { entryId: "e1", state: "queued" } },
        } as unknown as UIMessage,
      ],
    })
    render(<RunStatusBar sessionId={SID} />)
    fireEvent.click(screen.getByTestId("run-status-steer-chip"))
    expect(jumpToMessage).toHaveBeenCalledWith("m-e1")
  })

  it("stays inert when the queued steer has no reachable message", () => {
    const jumpToMessage = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage })
    seed({ status: "streaming", steerQueue: [{ id: "gone", text: "orphan" }], messages: [] })
    render(<RunStatusBar sessionId={SID} />)
    // Rendered as a plain span, not a button — there is nowhere to jump to.
    fireEvent.click(screen.getByTestId("run-status-steer-chip"))
    expect(jumpToMessage).not.toHaveBeenCalled()
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

  it("asks before the first interrupt-and-send, then fires it", async () => {
    const onSteerNow = jest.fn()
    useSettingsStore.setState({ settings: { steerInterruptConfirmed: false } as never })
    seed({ status: "streaming", steerQueue: [{ id: "x", text: "do X" }] })
    render(<RunStatusBar sessionId={SID} onSteerNow={onSteerNow} />)
    fireEvent.click(screen.getByTestId("run-panel-steer-now"))
    // Aborting in-flight tool calls is not obvious from the button, so the
    // first use must not go straight through.
    expect(onSteerNow).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("run-panel-steer-now-confirm"))
    await waitFor(() => expect(onSteerNow).toHaveBeenCalledTimes(1))
    expect(saveSettingsMock).toHaveBeenCalledWith({ steerInterruptConfirmed: true })
  })

  it("skips the confirm once the user has already accepted it", async () => {
    const onSteerNow = jest.fn()
    useSettingsStore.setState({ settings: { steerInterruptConfirmed: true } as never })
    seed({ status: "streaming", steerQueue: [{ id: "x", text: "do X" }] })
    render(<RunStatusBar sessionId={SID} onSteerNow={onSteerNow} />)
    fireEvent.click(screen.getByTestId("run-panel-steer-now"))
    await waitFor(() => expect(onSteerNow).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("run-panel-steer-now-confirm")).not.toBeInTheDocument()
  })

  it("does not show the busy interrupt-and-send affordance when idle", () => {
    // Idle + leftover queue surfaces the stuck-queue header (discard always
    // shown); without onSteerFlush there is no flush button.
    seed({ status: "idle", steerQueue: [{ id: "o", text: "orphan" }] })
    render(<RunStatusBar sessionId={SID} onSteerNow={jest.fn()} />)
    expect(screen.queryByTestId("run-panel-steer-now")).not.toBeInTheDocument()
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
