import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const listSdkSessions = jest.fn()
const renameSdkSession = jest.fn()
const deleteSdkSession = jest.fn()
const forkSdkSession = jest.fn()
const importSdkSessionToStore = jest.fn()
const getSdkSessionInfo = jest.fn()
const getSdkSessionMessages = jest.fn()
const listSdkSubagents = jest.fn()
const getSdkSubagentMessages = jest.fn()
const tagSdkSession = jest.fn()
const listChatSessions = jest.fn()
const persistMessages = jest.fn()
const startNewSession = jest.fn()
const replaceSessionMessages = jest.fn()
const setActiveSession = jest.fn()
const routerPush = jest.fn()
const toastError = jest.fn()

jest.mock("@/lib/claude/ipc", () => ({
  listSdkSessions: (...args: unknown[]) => listSdkSessions(...args),
  renameSdkSession: (...args: unknown[]) => renameSdkSession(...args),
  deleteSdkSession: (...args: unknown[]) => deleteSdkSession(...args),
  forkSdkSession: (...args: unknown[]) => forkSdkSession(...args),
  importSdkSessionToStore: (...args: unknown[]) => importSdkSessionToStore(...args),
  getSdkSessionInfo: (...args: unknown[]) => getSdkSessionInfo(...args),
  getSdkSessionMessages: (...args: unknown[]) => getSdkSessionMessages(...args),
  listSdkSubagents: (...args: unknown[]) => listSdkSubagents(...args),
  getSdkSubagentMessages: (...args: unknown[]) => getSdkSubagentMessages(...args),
  tagSdkSession: (...args: unknown[]) => tagSdkSession(...args),
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
jest.mock("@/lib/db/sessions", () => ({
  listSessions: (...args: unknown[]) => listChatSessions(...args),
}))
jest.mock("@/lib/db/messages", () => ({
  persistMessages: (...args: unknown[]) => persistMessages(...args),
}))
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSession(...args),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({ replaceSessionMessages, setActiveSession }),
  },
}))
jest.mock("@/components/chat/transcript-message-list", () => ({
  TranscriptMessageList: ({
    messages,
    sessionId,
  }: {
    messages: Array<{ id: string }>
    sessionId: string
  }) => (
    <div data-testid="sdk-transcript" data-session-id={sessionId}>
      {messages.map((message) => message.id).join(",")}
    </div>
  ),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  getAgentExecutionFlags: () => ({
    claudeSdkParityV1: true,
    claudeSdkSessionStore: true,
  }),
  isAgentExecutionFlagEnabled: () => true,
  subscribeToAgentExecutionFlags: () => () => {},
}))
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: jest.fn() },
}))

import { SdkSessionManager } from "./sdk-session-manager"

beforeEach(() => {
  jest.clearAllMocks()
  listSdkSessions.mockResolvedValue([
    { sessionId: "sdk-1", summary: "Fix auth", lastModified: 10, cwd: "/repo", tag: "work" },
  ])
  renameSdkSession.mockResolvedValue(undefined)
  deleteSdkSession.mockResolvedValue(undefined)
  forkSdkSession.mockResolvedValue({ sessionId: "sdk-2" })
  importSdkSessionToStore.mockResolvedValue({ imported: true })
  getSdkSessionInfo.mockResolvedValue({
    sessionId: "sdk-1",
    summary: "Fix auth",
    lastModified: 10,
    cwd: "/repo",
    tag: "work",
  })
  getSdkSessionMessages.mockResolvedValue([])
  listSdkSubagents.mockResolvedValue([])
  getSdkSubagentMessages.mockResolvedValue([])
  tagSdkSession.mockResolvedValue(undefined)
  listChatSessions.mockResolvedValue([])
  persistMessages.mockResolvedValue(undefined)
  startNewSession.mockResolvedValue({ id: "chat-new" })
})

describe("SdkSessionManager", () => {
  it("lists native SDK sessions and supports rename, fork, and confirmed delete", async () => {
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    expect(screen.getByText("/repo")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Rename SDK session" }))
    const input = screen.getByRole("textbox", { name: "Session title" })
    await user.clear(input)
    await user.type(input, "Fixed auth")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(renameSdkSession).toHaveBeenCalledWith("sdk-1", "Fixed auth"))

    await user.click(screen.getByRole("button", { name: "Fork SDK session" }))
    await waitFor(() => expect(forkSdkSession).toHaveBeenCalledWith("sdk-1"))

    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() => expect(deleteSdkSession).toHaveBeenCalledWith("sdk-1"))
  })

  it("surfaces load failures and retries", async () => {
    listSdkSessions.mockRejectedValueOnce(new Error("SDK unavailable"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("SDK sessions could not be loaded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Refresh SDK sessions" }))
    await waitFor(() => expect(listSdkSessions).toHaveBeenCalledTimes(2))
  })

  it("localizes rename failures", async () => {
    renameSdkSession.mockRejectedValueOnce(new Error("raw rename failure"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Rename SDK session" }))
    const input = screen.getByRole("textbox", { name: "Session title" })
    await user.clear(input)
    await user.type(input, "Renamed")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be renamed.")
    )
  })

  it("localizes fork failures", async () => {
    forkSdkSession.mockRejectedValueOnce(new Error("raw fork failure"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Fork SDK session" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be forked.")
    )
  })

  it("localizes delete failures", async () => {
    deleteSdkSession.mockRejectedValueOnce(new Error("raw delete failure"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be deleted.")
    )
  })

  it("imports a native transcript through the configured host SessionStore", async () => {
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Import into SessionStore" }))

    await waitFor(() =>
      expect(importSdkSessionToStore).toHaveBeenCalledWith(
        "sdk-1",
        expect.objectContaining({
          cwd: "/repo",
          execution: expect.objectContaining({
            hostRef: "desktop-sidecar",
            runtimeAdapter: "claude-agent-sdk",
          }),
          claudeAgentSdk: {
            version: 1,
            persistSession: true,
            sessionStore: { backend: "host-sqlite" },
          },
        })
      )
    )
  })

  it("localizes SessionStore import failures", async () => {
    importSdkSessionToStore.mockRejectedValueOnce(new Error("raw import failure"))
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Import into SessionStore" }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be imported.")
    )
  })

  it("edits and clears a native SDK session tag", async () => {
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Edit SDK session tag" }))
    const input = screen.getByRole("textbox", { name: "Session tag" })
    await user.clear(input)
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(tagSdkSession).toHaveBeenCalledWith("sdk-1", null))
  })

  it("loads main and subagent transcripts into the shared transcript renderer", async () => {
    const user = userEvent.setup()
    getSdkSessionMessages.mockResolvedValue({
      messages: [
        {
          type: "assistant",
          uuid: "main-a",
          session_id: "sdk-1",
          parent_tool_use_id: null,
          message: {
            id: "main-a",
            role: "assistant",
            content: [{ type: "text", text: "Main answer" }],
          },
        },
      ],
      nextCursor: "next-page",
    })
    listSdkSubagents.mockResolvedValue(["agent-1"])
    getSdkSubagentMessages.mockResolvedValue([
      {
        type: "assistant",
        uuid: "sub-a",
        session_id: "sdk-1",
        parent_tool_use_id: null,
        message: {
          id: "sub-a",
          role: "assistant",
          content: [{ type: "text", text: "Sub answer" }],
        },
      },
    ])
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Inspect SDK session" }))
    expect(await screen.findByTestId("sdk-transcript")).toHaveTextContent("main-a")
    expect(
      screen.getByText("The SDK returned a partial page of this transcript.")
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "agent-1" }))
    await waitFor(() => expect(getSdkSubagentMessages).toHaveBeenCalledWith("sdk-1", "agent-1"))
    expect(await screen.findByTestId("sdk-transcript")).toHaveTextContent("sub-a")
    expect(screen.getByTestId("sdk-transcript")).toHaveAttribute("data-session-id", "sdk-1:agent-1")
  })

  it("reuses an existing Chat binding without replacing its local transcript", async () => {
    const user = userEvent.setup()
    listChatSessions.mockResolvedValue([{ id: "chat-existing", sdkSessionId: "sdk-1" }])
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Continue in Chat" }))

    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith("chat-existing"))
    expect(getSdkSessionMessages).not.toHaveBeenCalled()
    expect(startNewSession).not.toHaveBeenCalled()
    expect(persistMessages).not.toHaveBeenCalled()
    expect(routerPush).toHaveBeenCalledWith("/")
  })

  it("creates and seeds a Chat binding from the native transcript", async () => {
    const user = userEvent.setup()
    getSdkSessionMessages.mockResolvedValue([
      {
        type: "user",
        uuid: "user-1",
        session_id: "sdk-1",
        parent_tool_use_id: null,
        message: { role: "user", content: "Please fix auth" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "sdk-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      },
    ])
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Continue in Chat" }))

    await waitFor(() =>
      expect(startNewSession).toHaveBeenCalledWith({
        title: "Fix auth",
        workingDir: "/repo",
        sdkSessionId: "sdk-1",
      })
    )
    expect(persistMessages).toHaveBeenCalledWith(
      "chat-new",
      expect.arrayContaining([
        expect.objectContaining({ id: "user-1", role: "user" }),
        expect.objectContaining({ id: "assistant-1", role: "assistant" }),
      ])
    )
    expect(replaceSessionMessages).toHaveBeenCalledWith("chat-new", expect.any(Array))
    expect(setActiveSession).toHaveBeenCalledWith("chat-new")
    expect(routerPush).toHaveBeenCalledWith("/")
  })

  it("keeps available details visible when one SDK details request fails", async () => {
    const user = userEvent.setup()
    getSdkSessionInfo.mockRejectedValue(new Error("not found"))
    getSdkSessionMessages.mockResolvedValue([])
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Inspect SDK session" }))

    expect(
      await screen.findByText(
        "Some session details could not be loaded. Available transcript data is shown below."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("No transcript messages were returned.")).toBeInTheDocument()
  })
})
