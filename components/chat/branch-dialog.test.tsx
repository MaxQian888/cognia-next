/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { UIMessage } from "ai"

jest.mock("sonner", () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}))
jest.mock("@/lib/chat/branch-session", () => ({
  __esModule: true,
  branchSessionAtMessage: jest.fn(),
}))
jest.mock("@/lib/ai/generation/summarizer", () => ({
  __esModule: true,
  summarizeConversation: jest.fn(),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  __esModule: true,
  buildUtilityLlmClient: jest.fn(() => null),
}))
jest.mock("@/lib/db/sessions", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({ id: "src1", title: "Original" })),
}))
jest.mock("@/stores/settings", () => ({
  __esModule: true,
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))
jest.mock("@/hooks/use-platform", () => ({
  __esModule: true,
  usePlatform: jest.fn(() => "web"),
}))
const addSessionToProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  __esModule: true,
  useProjectStore: { getState: () => ({ activeProjectId: null, addSessionToProject }) },
}))

import { BranchDialog } from "./branch-dialog"
import { branchSessionAtMessage } from "@/lib/chat/branch-session"
import { summarizeConversation } from "@/lib/ai/generation/summarizer"
import { toast } from "sonner"
import { useChatStore } from "@/stores/chat/chat-store"
import { usePlatform } from "@/hooks/use-platform"

const mockBranch = branchSessionAtMessage as jest.Mock
const mockSummarize = summarizeConversation as jest.Mock
const mockToastError = toast.error as jest.Mock
const mockToastSuccess = toast.success as jest.Mock

const messages = {
  chat: {
    branch: {
      title: "Branch conversation",
      description: "Fork this conversation.",
      cancel: "Cancel",
      confirm: "Create branch",
      created: "Branch created",
      createError: "Failed to create branch",
      summaryEmpty: "Add a summary before branching",
      summaryError: "Failed to generate summary",
      pick: {
        open: "Choose which messages to carry…",
        label: "Carry {count} selected",
        all: "Select all",
        none: "Clear",
        empty: "Pick at least one message",
        roleUser: "You",
        roleAssistant: "Assistant",
      },
      createdAside: "Branched into an aside",
      target: {
        label: "Where it goes",
        session: "A new conversation",
        sessionHint: "Appears in the sidebar.",
        aside: "A new aside on this conversation",
        asideHint: "Lives in the dock.",
      },
      direct: { label: "Direct branch", hint: "Copy verbatim." },
      summary: {
        label: "Branch from summary",
        hint: "Summarize and seed.",
        previewLabel: "Summary (editable)",
        regenerate: "Regenerate",
        generating: "Generating…",
        placeholder: "Summary will appear here.",
      },
    },
  },
}

function setMessages() {
  useChatStore.setState({
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "a" }] },
    ] as UIMessage[],
    activeBranchByGroup: {},
  })
}

function renderDialog(onOpenChange = jest.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <BranchDialog sessionId="src1" messageId="a1" open onOpenChange={onOpenChange} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(usePlatform as jest.Mock).mockReturnValue("web")
  useChatStore.setState({ splitSessionId: null, openSessionIds: [], activeSessionId: "src1" })
  setMessages()
  mockBranch.mockResolvedValue({ id: "child1" })
  mockSummarize.mockResolvedValue("Generated summary")
})

describe("BranchDialog — reads the branched session's own thread", () => {
  // The dialog used to read the store's top-level `messages`, which mirrors the
  // ACTIVE session only. Both callers already address the message's own session
  // (`message-renderer` resolves `metadata.sessionId`; the mobile action sheet
  // passes `branchTarget.sessionId`), so branching from a split pane or a
  // sidechat looked the cut-off message up in a thread that does not contain it
  // — every such attempt failed with nothing but a generic toast.
  it("branches a background pane from ITS slice, not the active session's", async () => {
    useChatStore.setState({
      activeSessionId: "other",
      // The active projection deliberately does NOT contain the cut-off message.
      messages: [{ id: "zzz", role: "user", parts: [{ type: "text", text: "elsewhere" }] }],
      activeBranchByGroup: {},
      sessions: {
        src1: {
          ...useChatStore.getState().sessions.src1,
          messages: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] },
            { id: "a1", role: "assistant", parts: [{ type: "text", text: "a" }] },
          ] as UIMessage[],
          activeBranchByGroup: {},
        },
      } as never,
    })

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BranchDialog sessionId="src1" messageId="a1" open onOpenChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByText("Create branch"))

    await waitFor(() => expect(mockBranch).toHaveBeenCalledTimes(1))
    const call = mockBranch.mock.calls[0][0]
    expect(call.sourceId).toBe("src1")
    expect(call.visibleMessages.map((m: UIMessage) => m.id)).toEqual(["u1", "a1"])
  })
})

describe("BranchDialog", () => {
  it("creates a direct branch and opens it beside its parent", async () => {
    const onOpenChange = jest.fn()
    renderDialog(onOpenChange)
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockBranch).toHaveBeenCalledTimes(1))
    expect(mockBranch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "src1", messageId: "a1", mode: "direct" })
    )
    const state = useChatStore.getState()
    // Beside, not instead of: the parent stays focused and may still be running.
    expect(state.splitSessionId).toBe("child1")
    // The split pane only renders for a session that is also open.
    expect(state.openSessionIds).toContain("child1")
    expect(state.activeSessionId).not.toBe("child1")
    expect(mockToastSuccess).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("switches to the branch on mobile, which has no split view", async () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    try {
      renderDialog()
      fireEvent.click(screen.getByText("Create branch"))
      await waitFor(() => expect(useChatStore.getState().activeSessionId).toBe("child1"))
      expect(useChatStore.getState().splitSessionId).toBeNull()
    } finally {
      ;(usePlatform as jest.Mock).mockReturnValue("web")
    }
  })

  it("carries only the picked messages when the user narrows the selection", async () => {
    // Branching took the whole prefix or nothing; in a long thread that drags
    // every dead end along and the model weighs them equally.
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /Choose which messages/ }))
    // Opens with everything checked — narrowing is opt-in from the status quo.
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes).toHaveLength(2)
    fireEvent.click(boxes[0])

    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() =>
      expect(mockBranch).toHaveBeenCalledWith(expect.objectContaining({ pickedMessageIds: ["a1"] }))
    )
  })

  it("refuses to branch when the selection is emptied", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /Choose which messages/ }))
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockBranch).not.toHaveBeenCalled()
  })

  it("sends no selection at all when the picker was never opened", async () => {
    // The default stays exactly what it was: everything up to the cut-off.
    renderDialog()
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockBranch).toHaveBeenCalledTimes(1))
    expect(mockBranch.mock.calls[0][0].pickedMessageIds).toBeUndefined()
  })

  it("auto-generates a summary when switching to summary mode", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("radio", { name: /Branch from summary/ }))
    await waitFor(() => expect(mockSummarize).toHaveBeenCalledTimes(1))
    expect(await screen.findByDisplayValue("Generated summary")).toBeInTheDocument()
  })

  it("passes the edited summary text to the branch", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("radio", { name: /Branch from summary/ }))
    const textarea = await screen.findByDisplayValue("Generated summary")
    fireEvent.change(textarea, { target: { value: "Edited summary" } })
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() =>
      expect(mockBranch).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "summary", summaryText: "Edited summary" })
      )
    )
  })

  it("blocks a summary branch with empty summary", async () => {
    mockSummarize.mockResolvedValue("")
    renderDialog()
    fireEvent.click(screen.getByRole("radio", { name: /Branch from summary/ }))
    await waitFor(() => expect(mockSummarize).toHaveBeenCalled())
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockBranch).not.toHaveBeenCalled()
  })

  it("regenerates the summary on demand", async () => {
    renderDialog()
    fireEvent.click(screen.getByRole("radio", { name: /Branch from summary/ }))
    await waitFor(() => expect(mockSummarize).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText("Regenerate"))
    await waitFor(() => expect(mockSummarize).toHaveBeenCalledTimes(2))
  })

  it("surfaces a creation error", async () => {
    mockBranch.mockRejectedValue(new Error("nope"))
    renderDialog()
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
  })

  it("surfaces a summary generation error", async () => {
    mockSummarize.mockRejectedValue(new Error("boom"))
    renderDialog()
    fireEvent.click(screen.getByRole("radio", { name: /Branch from summary/ }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
  })

  it("cancel closes without branching", () => {
    const onOpenChange = jest.fn()
    renderDialog(onOpenChange)
    fireEvent.click(screen.getByText("Cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockBranch).not.toHaveBeenCalled()
  })
})
