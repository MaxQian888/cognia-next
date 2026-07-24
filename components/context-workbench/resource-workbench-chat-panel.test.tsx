import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceWorkbenchChatPanel } from "./resource-workbench-chat-panel"
import { useChatStore } from "@/stores/chat"
import { listMessages } from "@/lib/db/messages"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"

const send = jest.fn().mockResolvedValue(undefined)
const stop = jest.fn()
const regenerate = jest.fn()
const editAndResend = jest.fn()
const exportRun = jest.fn()
const attachmentManifest: readonly AttachmentManifestEntry[] = [
  { filename: "report.txt", mediaType: "text/plain", kind: "document" },
]
let mockResource: Record<string, unknown> = { kind: "project-file", relPath: "src/a.ts" }

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/hooks/data/use-single-export", () => ({
  useSingleExport: () => ({ run: exportRun, busy: false }),
}))
jest.mock("./context-workbench", () => ({
  useContextWorkbench: () => ({
    resource: mockResource,
  }),
}))

jest.mock("@/components/chat/chat-scope-provider", () => ({
  useChatScope: () => ({ sessionId: "resource-session" }),
}))
jest.mock("@/hooks/chat/use-claude-chat", () => ({
  useClaudeChat: () => ({
    send,
    stop,
    regenerate,
    editAndResend,
  }),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({ id: "resource-session", title: "Resource" }),
}))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get: jest.fn() } }) }))
jest.mock("@/stores/chat", () => {
  const state = {
    sessions: {},
    setSessionMessages: jest.fn(),
    setSessionMessagesLoadError: jest.fn(),
    setPendingArtifactEditTarget: jest.fn(),
  }
  const useChatStore = (selector: (value: typeof state) => unknown) => selector(state)
  useChatStore.getState = () => state
  return { useChatStore }
})
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: ({
    onSend,
    onStop,
    onRegenerate,
    onEditResend,
    onUseSample,
    onCreate,
    onOpenSettings,
  }: {
    onSend: (content: string, manifest?: readonly AttachmentManifestEntry[]) => Promise<unknown>
    onStop: () => void
    onRegenerate: () => void
    onEditResend: (messageId: string, content: string) => void
    onUseSample: (content: string) => void
    onCreate: () => void
    onOpenSettings: () => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => void onSend("hello", attachmentManifest).catch(() => undefined)}
      >
        send
      </button>
      <button type="button" onClick={onStop}>
        stop
      </button>
      <button type="button" onClick={onRegenerate}>
        regenerate
      </button>
      <button type="button" onClick={() => onEditResend("m1", "edited")}>
        edit
      </button>
      <button type="button" onClick={() => onUseSample("sample")}>
        sample
      </button>
      <button type="button" onClick={onCreate}>
        create
      </button>
      <button type="button" onClick={onOpenSettings}>
        settings
      </button>
    </div>
  ),
}))

const mockListMessages = listMessages as jest.MockedFunction<typeof listMessages>

describe("ResourceWorkbenchChatPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListMessages.mockResolvedValue([])
    ;(useChatStore.getState().setPendingArtifactEditTarget as jest.Mock).mockClear()
    mockResource = { kind: "project-file", relPath: "src/a.ts" }
  })
  it("dispatches through its scoped embedded session", async () => {
    render(<ResourceWorkbenchChatPanel />)
    await userEvent.click(await screen.findByRole("button", { name: "send" }))
    expect(send).toHaveBeenCalledWith("hello", undefined, {
      sessionId: "resource-session",
      resourceContext: "",
      attachmentManifest,
    })
  })

  it("attaches selection coordinates to the final scoped prompt", async () => {
    mockResource = {
      kind: "project-file",
      relPath: "src/a.ts",
      selection: { kind: "text", start: 2, end: 5 },
    }
    render(<ResourceWorkbenchChatPanel getResourceContext={() => "abcdef"} />)
    await userEvent.click(screen.getByRole("button", { name: "send" }))
    expect(send).toHaveBeenCalledWith("hello", undefined, {
      sessionId: "resource-session",
      resourceContext: expect.stringContaining('"start":2'),
      attachmentManifest,
    })
  })

  it("keeps chat controls and explicit embedded export scoped to the session", async () => {
    const user = userEvent.setup()
    render(<ResourceWorkbenchChatPanel />)
    await user.click(screen.getByRole("button", { name: "stop" }))
    await user.click(screen.getByRole("button", { name: "regenerate" }))
    await user.click(screen.getByRole("button", { name: "edit" }))
    await user.click(screen.getByRole("button", { name: "sample" }))
    await user.click(screen.getByRole("button", { name: "create" }))
    await user.click(screen.getByRole("button", { name: "settings" }))
    await user.click(screen.getByRole("button", { name: "exportResourceSession" }))
    expect(stop).toHaveBeenCalledWith("resource-session")
    expect(regenerate).toHaveBeenCalledWith("resource-session", "")
    expect(editAndResend).toHaveBeenCalledWith("m1", "edited", "resource-session", "")
    expect(send).toHaveBeenCalledWith("sample", undefined, {
      sessionId: "resource-session",
      resourceContext: "",
    })
    expect(exportRun).toHaveBeenCalledWith(
      expect.objectContaining({ format: "markdown", session: expect.any(Object) })
    )
  })

  it("clears a pending artifact target when context assembly fails", async () => {
    mockResource = { kind: "artifact", artifactId: "artifact-1" }
    render(
      <ResourceWorkbenchChatPanel getResourceContext={() => Promise.reject(new Error("failed"))} />
    )
    await userEvent.click(screen.getByRole("button", { name: "send" }))
    const setPendingArtifactEditTarget = useChatStore.getState()
      .setPendingArtifactEditTarget as jest.Mock
    expect(setPendingArtifactEditTarget).toHaveBeenNthCalledWith(
      1,
      "resource-session",
      expect.objectContaining({ artifactId: "artifact-1" })
    )
    expect(setPendingArtifactEditTarget).toHaveBeenLastCalledWith("resource-session", null)
  })

  it("reports message loading failures to the scoped session", async () => {
    mockListMessages.mockRejectedValueOnce("load failed")
    render(<ResourceWorkbenchChatPanel />)

    await waitFor(() =>
      expect(useChatStore.getState().setSessionMessagesLoadError).toHaveBeenCalledWith(
        "resource-session",
        "load failed"
      )
    )
  })

  it("keeps the artifact target attached after a successful send", async () => {
    mockResource = { kind: "artifact", artifactId: "artifact-1" }
    render(<ResourceWorkbenchChatPanel getResourceContext={() => "artifact body"} />)
    await userEvent.click(screen.getByRole("button", { name: "send" }))

    expect(useChatStore.getState().setPendingArtifactEditTarget).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("hello", undefined, {
      sessionId: "resource-session",
      resourceContext: "artifact body",
      attachmentManifest,
    })
  })

  it("submits a bridged selection comment once and acknowledges it", async () => {
    const consumed = jest.fn()
    const view = render(
      <ResourceWorkbenchChatPanel
        getResourceContext={() => "artifact body"}
        pendingPrompt="Rewrite this selection"
        onPendingPromptConsumed={consumed}
      />
    )

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Rewrite this selection", undefined, {
        sessionId: "resource-session",
        resourceContext: "artifact body",
      })
    )
    expect(consumed).toHaveBeenCalledTimes(1)
    view.rerender(
      <ResourceWorkbenchChatPanel
        getResourceContext={() => "artifact body"}
        pendingPrompt="Rewrite this selection"
        onPendingPromptConsumed={consumed}
      />
    )
    expect(send).toHaveBeenCalledTimes(1)
  })
})
