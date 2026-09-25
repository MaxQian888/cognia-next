/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ChatCopilotIntent, ChatCopilotView } from "@/lib/reply-copilot/screen/overlay-client"
import type { CopilotResult } from "@/lib/reply-copilot/run-copilot"

let viewHandler: ((view: ChatCopilotView) => void) | null = null
const intents: ChatCopilotIntent[] = []
const resize = jest.fn(async (_width: number, _height: number) => undefined)
const reveal = jest.fn(async () => undefined)

const hostCopy = jest.fn(async (_text: string) => undefined)
jest.mock("@/lib/reply-copilot/screen/overlay-client", () => ({
  copyFromChatCopilotOverlay: (text: string) => hostCopy(text),
  onChatCopilotView: async (handler: (view: ChatCopilotView) => void) => {
    viewHandler = handler
    return () => {
      viewHandler = null
    }
  },
  sendChatCopilotIntent: async (intent: ChatCopilotIntent) => {
    intents.push(intent)
    return true
  },
  resizeChatCopilotOverlay: (w: number, h: number) => resize(w, h),
  revealChatCopilotOverlay: () => reveal(),
}))
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copy: jest.fn(async () => true), copied: false, isCopying: false }),
}))

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub

import { ChatCopilotOverlay } from "./chat-copilot-overlay"

const read = {
  appName: "WeChat",
  windowTitle: "WeChat",
  bubbleCount: 4,
  unsidedReason: null,
  contact: { kind: "match" as const, name: "Ann" },
}

const result: CopilotResult = {
  variant: "full",
  judge: { kind: "unavailable", reason: "no_provider" },
  drafts: {
    kind: "ok",
    ranked: false,
    rankSkipped: "no_provider",
    candidates: [{ text: "三点可以", probability: null, slot: 0 }],
  },
}

async function mount() {
  render(<ChatCopilotOverlay />)
  await act(async () => {})
}

function push(view: ChatCopilotView) {
  act(() => viewHandler?.(view))
}

beforeEach(() => {
  intents.length = 0
  viewHandler = null
})

describe("ChatCopilotOverlay", () => {
  it("asks for the current view on mount, reveals itself and paints transparent", async () => {
    await mount()
    expect(intents).toEqual([{ kind: "ready" }])
    expect(reveal).toHaveBeenCalled()
    expect(document.documentElement).toHaveAttribute("data-pet-overlay", "true")
    expect(screen.getByRole("status")).toHaveTextContent("Capturing the chat window…")
  })

  it("asks for the capture's consent and sends the answer back", async () => {
    await mount()
    push({
      phase: "consent",
      runId: 1,
      consent: {
        id: "c1",
        processName: "WeChat",
        windowTitle: "Ann",
        expiresAt: Date.now() + 30_000,
      },
    })
    expect(
      screen.getByText("Let the chat copilot read the window of WeChat in front, once?")
    ).toBeInTheDocument()
    expect(screen.getByText("Window: Ann")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }))
    fireEvent.click(screen.getAllByRole("button", { name: /min$/ })[0])
    expect(intents.slice(1)).toEqual([
      { kind: "consent", id: "c1", allow: true },
      { kind: "consent", id: "c1", allow: false },
      { kind: "consent", id: "c1", allow: true, grantDurationMs: expect.any(Number) },
    ])
  })

  it("shows the candidates with copy only, the read summary and a steered redraft", async () => {
    await mount()
    push({
      phase: "done",
      runId: 2,
      read,
      result,
      knowledge: {
        relationship: "",
        background: "",
        contactId: null,
        contactName: null,
        hasNote: false,
        memoryLines: 0,
        memorySkipped: "disabled",
      },
      instructions: "",
    })
    expect(screen.getByText("三点可以")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Use" })).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }))
    })
    expect(hostCopy).toHaveBeenCalledWith("三点可以")
    expect(screen.getByText("Read 4 messages from WeChat.")).toBeInTheDocument()
    expect(screen.getByText("Using what you noted about Ann.")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("What you want to say (optional)"), {
      target: { value: "say 3pm" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Draft again" }))
    fireEvent.click(screen.getByRole("button", { name: "Read the chat again" }))
    expect(intents.slice(1)).toEqual([
      { kind: "redraft", instructions: "say 3pm" },
      { kind: "retry" },
    ])
  })

  it("explains why senders are unknown", async () => {
    await mount()
    push({
      phase: "thinking",
      runId: 3,
      read: { ...read, unsidedReason: "single_column" },
      instructions: "",
    })
    expect(
      screen.getByText(
        "This app shows everyone's messages in one column, so senders can't be told apart."
      )
    ).toBeInTheDocument()
  })

  it("links a missing Screen Recording grant to System Settings", async () => {
    await mount()
    push({ phase: "error", runId: 4, error: "screen_recording_required" })
    fireEvent.click(screen.getByRole("button", { name: "Open Screen Recording settings" }))
    expect(intents.at(-1)).toEqual({ kind: "openScreenRecordingSettings" })
  })

  it("retries a failed draft with the same instructions", async () => {
    await mount()
    push({ phase: "error", runId: 5, error: "draft_failed", read, instructions: "decline" })
    expect(screen.getByText("The copilot could not finish. Try again.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Draft again" }))
    expect(intents.at(-1)).toEqual({ kind: "redraft", instructions: "decline" })
  })

  it("closes on Escape or the close button", async () => {
    await mount()
    fireEvent.keyDown(window, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(intents.slice(1)).toEqual([{ kind: "close" }, { kind: "close" }])
  })
})
