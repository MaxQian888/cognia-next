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
  setMessages()
  mockBranch.mockResolvedValue({ id: "child1" })
  mockSummarize.mockResolvedValue("Generated summary")
})

describe("BranchDialog", () => {
  it("creates a direct branch and switches to it", async () => {
    const onOpenChange = jest.fn()
    renderDialog(onOpenChange)
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockBranch).toHaveBeenCalledTimes(1))
    expect(mockBranch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "src1", messageId: "a1", mode: "direct" })
    )
    expect(useChatStore.getState().activeSessionId).toBe("child1")
    expect(mockToastSuccess).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("auto-generates a summary when switching to summary mode", async () => {
    renderDialog()
    fireEvent.click(screen.getAllByRole("radio")[1])
    await waitFor(() => expect(mockSummarize).toHaveBeenCalledTimes(1))
    expect(await screen.findByDisplayValue("Generated summary")).toBeInTheDocument()
  })

  it("passes the edited summary text to the branch", async () => {
    renderDialog()
    fireEvent.click(screen.getAllByRole("radio")[1])
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
    fireEvent.click(screen.getAllByRole("radio")[1])
    await waitFor(() => expect(mockSummarize).toHaveBeenCalled())
    fireEvent.click(screen.getByText("Create branch"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockBranch).not.toHaveBeenCalled()
  })

  it("regenerates the summary on demand", async () => {
    renderDialog()
    fireEvent.click(screen.getAllByRole("radio")[1])
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
    fireEvent.click(screen.getAllByRole("radio")[1])
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
