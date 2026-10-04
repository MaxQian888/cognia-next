import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
const toastSuccess = jest.fn()
const clearSessionSdkLink = jest.fn()
let mockSessionStoreEnabled = true

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
  updateSession: jest.fn(async () => undefined),
  clearSessionSdkLink: (...args: unknown[]) => clearSessionSdkLink(...args),
}))
// The linked-chat read is a Dexie live query in the app; here it resolves the
// mocked `listSessions` once per mount, which is all the badge needs.
jest.mock("@/hooks/data/use-client-live-query", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react")
  return {
    useClientLiveQuery: <T,>(query: () => Promise<T> | T) => {
      const [value, setValue] = React.useState<T | undefined>(undefined)
      React.useEffect(() => {
        let live = true
        void Promise.resolve(query()).then((next) => {
          if (live) setValue(next)
        })
        return () => {
          live = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return value
    },
  }
})
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
// The manager gates on the host PROFILE: a desktop here, so the environment it
// hands the resolver is the desktop sidecar's (see the `hostRef` pin below).
const mockHostProfile = jest.fn((): string => "desktop")
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  detectHostProfile: () => mockHostProfile(),
}))
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  getAgentExecutionFlags: () => ({
    claudeSdkParityV1: true,
    claudeSdkSessionStore: true,
  }),
  isAgentExecutionFlagEnabled: (key: string) =>
    key !== "claudeSdkSessionStore" || mockSessionStoreEnabled,
  subscribeToAgentExecutionFlags: () => () => {},
}))
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

import { SdkSessionManager } from "./sdk-session-manager"

beforeEach(() => {
  jest.clearAllMocks()
  mockSessionStoreEnabled = true
  // `clearAllMocks` keeps return values; a case that picked another shell must
  // not leak it into the next one.
  mockHostProfile.mockReturnValue("desktop")
  listSdkSessions.mockImplementation(async (_params, options) =>
    options?.claudeAgentSdk?.sessionStore
      ? []
      : [{ sessionId: "sdk-1", summary: "Fix auth", lastModified: 10, cwd: "/repo", tag: "work" }]
  )
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
  clearSessionSdkLink.mockResolvedValue(undefined)
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
    await waitFor(() =>
      expect(renameSdkSession).toHaveBeenCalledWith(
        "sdk-1",
        "Fixed auth",
        expect.objectContaining({ cwd: "/repo", claudeAgentSdk: { version: 1 } })
      )
    )

    await user.click(screen.getByRole("button", { name: "Fork SDK session" }))
    await waitFor(() =>
      expect(forkSdkSession).toHaveBeenCalledWith(
        "sdk-1",
        expect.objectContaining({ cwd: "/repo", claudeAgentSdk: { version: 1 } })
      )
    )

    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() =>
      expect(deleteSdkSession).toHaveBeenCalledWith(
        "sdk-1",
        expect.objectContaining({ cwd: "/repo", claudeAgentSdk: { version: 1 } })
      )
    )
  })

  it.each(["mobile-companion", "cloud-companion", "headless"])(
    "lists the host's SDK sessions from a %s shell",
    async (profile) => {
      // `agent_session_api` is an execution-target command the host's sidecar
      // answers; gating on `isTauri()` hid this whole manager from every
      // companion although the paired host could list, fork and rename.
      mockHostProfile.mockReturnValue(profile)
      render(<SdkSessionManager />)
      expect(await screen.findByText("Fix auth")).toBeInTheDocument()
      expect(listSdkSessions).toHaveBeenCalled()
    }
  )

  it("renders nothing in a standalone browser, which has no host to list from", () => {
    mockHostProfile.mockReturnValue("web-standalone")
    const { container } = render(<SdkSessionManager />)
    expect(container).toBeEmptyDOMElement()
    expect(listSdkSessions).not.toHaveBeenCalled()
  })

  it("surfaces load failures and retries", async () => {
    listSdkSessions.mockRejectedValueOnce(new Error("SDK unavailable"))
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("SDK sessions could not be loaded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Refresh SDK sessions" }))
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    expect(
      listSdkSessions.mock.calls.filter((call) => !call[1]?.claudeAgentSdk?.sessionStore)
    ).toHaveLength(2)
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

    await waitFor(() =>
      expect(tagSdkSession).toHaveBeenCalledWith(
        "sdk-1",
        null,
        expect.objectContaining({ cwd: "/repo", claudeAgentSdk: { version: 1 } })
      )
    )
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

    await user.click(screen.getByRole("button", { name: "Subagent agent-1" }))
    await waitFor(() =>
      expect(getSdkSubagentMessages).toHaveBeenCalledWith(
        "sdk-1",
        "agent-1",
        expect.objectContaining({ cwd: "/repo", claudeAgentSdk: { version: 1 } })
      )
    )
    expect(await screen.findByTestId("sdk-transcript")).toHaveTextContent("sub-a")
    expect(screen.getByTestId("sdk-transcript")).toHaveAttribute("data-session-id", "sdk-1:agent-1")
  })

  it("reuses an existing Chat binding without replacing its local transcript", async () => {
    const user = userEvent.setup()
    listChatSessions.mockResolvedValue([{ id: "chat-existing", sdkSessionId: "sdk-1" }])
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Continue in Chat" }))

    // Navigates through the session link, which switches to the chat's
    // workspace before focusing it; a store-only switch left Settings on screen.
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/?session=chat-existing"))
    expect(setActiveSession).not.toHaveBeenCalled()
    expect(getSdkSessionMessages).not.toHaveBeenCalled()
    expect(startNewSession).not.toHaveBeenCalled()
    expect(persistMessages).not.toHaveBeenCalled()
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
        sdkSessionStorage: { backend: "host-sqlite", workspace: "/repo" },
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
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/?session=chat-new"))
    expect(setActiveSession).not.toHaveBeenCalled()
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
  it("keeps recorded store sessions discoverable after the rollout is disabled", async () => {
    mockSessionStoreEnabled = false
    listChatSessions.mockResolvedValue([
      {
        id: "chat-stored",
        sdkSessionId: "stored",
        workingDir: "/changed",
        sdkSessionStorage: { backend: "host-sqlite", workspace: "/original" },
      },
    ])
    listSdkSessions.mockImplementation(async (_params, options) =>
      options?.cwd === "/original"
        ? [
            {
              sessionId: "stored",
              summary: "Recorded store session",
              cwd: "/changed",
              lastModified: 2,
            },
          ]
        : []
    )
    render(<SdkSessionManager />)
    expect(await screen.findByText("Recorded store session")).toBeInTheDocument()
    expect(listSdkSessions).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        cwd: "/original",
        claudeAgentSdk: expect.objectContaining({ sessionStore: { backend: "host-sqlite" } }),
      })
    )
    expect(listSdkSessions.mock.calls.some((call) => call[1]?.cwd === "/changed")).toBe(false)
  })

  it("lists store scopes and keeps every row operation bound to its original workspace", async () => {
    listSdkSessions.mockImplementation(async (_params, options) => {
      if (!options?.claudeAgentSdk?.sessionStore)
        return [{ sessionId: "disk", summary: "Disk", cwd: "/repo", lastModified: 1 }]
      return options.cwd === "/repo"
        ? [{ sessionId: "stored", summary: "Stored", cwd: "/repo", lastModified: 2 }]
        : []
    })
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Stored")).toBeInTheDocument()
    const row = screen.getByText("Stored").closest("li")!
    await user.click(within(row).getByRole("button", { name: "Fork SDK session" }))
    await waitFor(() =>
      expect(forkSdkSession).toHaveBeenCalledWith(
        "stored",
        expect.objectContaining({
          cwd: "/repo",
          execution: expect.objectContaining({ hostRef: "desktop-sidecar" }),
          claudeAgentSdk: {
            version: 1,
            persistSession: true,
            sessionStore: { backend: "host-sqlite" },
          },
        })
      )
    )
    expect(screen.getByText("Disk")).toBeInTheDocument()
  })
  it("renders a busy skeleton instead of an empty list while the first load is in flight", async () => {
    let resolve: (rows: unknown[]) => void = () => {}
    listSdkSessions.mockImplementation(
      (_params, options) =>
        new Promise((done) => {
          if (options?.claudeAgentSdk?.sessionStore) done([])
          else resolve = done
        })
    )
    render(<SdkSessionManager />)
    const block = screen.getByTestId("sdk-session-manager")
    expect(block.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(within(block).queryByRole("list")).not.toBeInTheDocument()
    expect(screen.queryByText("No native SDK sessions were found.")).not.toBeInTheDocument()

    await waitFor(() => expect(listSdkSessions).toHaveBeenCalled())
    resolve([{ sessionId: "sdk-1", summary: "Fix auth", lastModified: 10, cwd: "/repo" }])
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    expect(block.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it("puts the count in the header badge and the refresh in the header action", async () => {
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    const block = screen.getByTestId("sdk-session-manager")
    expect(within(block).getByText(/^1 native session/)).toBeInTheDocument()
    expect(within(block).getByRole("button", { name: "Refresh SDK sessions" })).toBeEnabled()
  })

  it("sorts rows newest first and shows when each was last modified", async () => {
    listSdkSessions.mockImplementation(async (_params, options) =>
      options?.claudeAgentSdk?.sessionStore
        ? []
        : [
            { sessionId: "old", summary: "Older work", lastModified: 1_000, cwd: "/a" },
            { sessionId: "new", summary: "Newer work", lastModified: 5_000, cwd: "/b" },
          ]
    )
    render(<SdkSessionManager />)
    expect(await screen.findByText("Newer work")).toBeInTheDocument()
    const items = within(screen.getByRole("list")).getAllByRole("listitem")
    expect(items.map((item) => within(item).getByText(/work$/).textContent)).toEqual([
      "Newer work",
      "Older work",
    ])
    // The global next-intl mock renders relativeTime as the ISO instant.
    expect(
      within(items[0]!).getByText(`Updated ${new Date(5_000).toISOString()}`)
    ).toBeInTheDocument()
  })

  it("marks a native session a Cognia chat resumes and opens that chat from the badge", async () => {
    const user = userEvent.setup()
    listChatSessions.mockResolvedValue([
      { id: "chat-1", title: "Auth chat", sdkSessionId: "sdk-1", updatedAt: 2 },
      // Embedded rows resume SDK sessions too, but are not openable chats.
      { id: "wf", kind: "workflow-editor", sdkSessionId: "sdk-1", updatedAt: 9 },
    ])
    render(<SdkSessionManager />)
    const badge = await screen.findByRole("button", { name: "Open the linked chat “Auth chat”" })
    expect(badge).toHaveTextContent(/Linked to/)
    await user.click(badge)
    expect(routerPush).toHaveBeenCalledWith("/?session=chat-1")
  })

  it("shows no linked badge for a chat bound to another storage copy", async () => {
    listChatSessions.mockResolvedValue([
      {
        id: "chat-store",
        title: "Stored",
        sdkSessionId: "sdk-1",
        sdkSessionStorage: { backend: "host-sqlite", workspace: "/repo" },
      },
    ])
    mockSessionStoreEnabled = false
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    await waitFor(() => expect(listChatSessions).toHaveBeenCalled())
    expect(screen.queryByText(/Linked to/)).not.toBeInTheDocument()
  })

  it("clears the link of every chat bound to a deleted native session", async () => {
    const user = userEvent.setup()
    listChatSessions.mockResolvedValue([
      { id: "chat-1", title: "Auth chat", sdkSessionId: "sdk-1", updatedAt: 2 },
      { id: "wf", kind: "workflow-editor", sdkSessionId: "sdk-1", updatedAt: 1 },
      { id: "other", sdkSessionId: "sdk-9", updatedAt: 3 },
    ])
    render(<SdkSessionManager />)
    expect(
      await screen.findByRole("button", { name: "Open the linked chat “Auth chat”" })
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    expect(
      screen.getByText(/2 linked Cognia chats keep their messages/, { exact: false })
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))

    await waitFor(() => expect(clearSessionSdkLink).toHaveBeenCalledTimes(2))
    expect(clearSessionSdkLink).toHaveBeenCalledWith("chat-1")
    expect(clearSessionSdkLink).toHaveBeenCalledWith("wf")
    expect(clearSessionSdkLink).not.toHaveBeenCalledWith("other")
    expect(toastSuccess).toHaveBeenCalledWith("SDK session deleted.")
  })

  it("does not touch chat links when the native delete fails", async () => {
    const user = userEvent.setup()
    deleteSdkSession.mockRejectedValueOnce(new Error("raw"))
    listChatSessions.mockResolvedValue([{ id: "chat-1", sdkSessionId: "sdk-1" }])
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The SDK session could not be deleted.")
    )
    expect(clearSessionSdkLink).not.toHaveBeenCalled()
  })

  it("says so when a linked chat could not be unlinked after the delete", async () => {
    const user = userEvent.setup()
    listChatSessions.mockResolvedValue([{ id: "chat-1", sdkSessionId: "sdk-1" }])
    clearSessionSdkLink.mockRejectedValueOnce(new Error("handoff lock"))
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Delete SDK session" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "The SDK session was deleted, but a linked chat could not be unlinked. Unlink it from the SDK-bound conversations list."
      )
    )
    expect(toastSuccess).not.toHaveBeenCalledWith("SDK session deleted.")
  })

  it("submits the rename dialog on Enter and disables Save while the rename runs", async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    renameSdkSession.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          finish = done
        })
    )
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Rename SDK session" }))
    const input = screen.getByRole("textbox", { name: "Session title" })
    await user.clear(input)
    await user.type(input, "Via enter{Enter}")
    await waitFor(() =>
      expect(renameSdkSession).toHaveBeenCalledWith("sdk-1", "Via enter", expect.anything())
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("submits the tag dialog on Enter", async () => {
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Edit SDK session tag" }))
    const input = screen.getByRole("textbox", { name: "Session tag" })
    await user.clear(input)
    await user.type(input, "review{Enter}")
    await waitFor(() =>
      expect(tagSdkSession).toHaveBeenCalledWith("sdk-1", "review", expect.anything())
    )
  })

  it("widens the details dialog past the base sm:max-w-lg cap", async () => {
    const user = userEvent.setup()
    render(<SdkSessionManager />)
    expect(await screen.findByText("Fix auth")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Inspect SDK session" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog.className).toContain("sm:max-w-4xl")
  })
})
