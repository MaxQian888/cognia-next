import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
let mockSession: Record<string, unknown> = { id: "resource-session", title: "Resource" }
const updateSession = jest.fn().mockResolvedValue(undefined)
const setSessionOverride = jest.fn()

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
  useLiveQuery: () => mockSession,
}))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (...args: unknown[]) => updateSession(...args),
}))
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
jest.mock("./aside-switcher", () => ({
  AsideSwitcher: (props: {
    activeId: string
    primaryId: string
    onSelect: (sessionId: string) => void
  }) => (
    <button
      data-testid="aside-switcher"
      data-active={props.activeId}
      data-primary={props.primaryId}
      onClick={() => props.onSelect(props.primaryId)}
    />
  ),
}))
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: (selector: (s: { setSessionOverride: jest.Mock }) => unknown) =>
    selector({ setSessionOverride }),
}))
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
    onSend: (
      content: string,
      manifest?: readonly AttachmentManifestEntry[],
      templateRun?: unknown,
      metadata?: { webSearchContext?: { provider: string; results: unknown[] } }
    ) => Promise<unknown>
    onStop: () => void
    onRegenerate: () => void
    onEditResend: (messageId: string, content: string) => void
    onUseSample: (content: string) => void
    onCreate: () => void
    onOpenSettings: () => void
  }) => (
    <div data-testid="chat-pane">
      <button
        type="button"
        onClick={() => void onSend("hello", attachmentManifest).catch(() => undefined)}
      >
        send
      </button>
      <button
        type="button"
        onClick={() =>
          void onSend("web", undefined, null, {
            webSearchContext: {
              provider: "tavily",
              results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
            },
          }).catch(() => undefined)
        }
      >
        send web
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
    mockSession = { id: "resource-session", title: "Resource" }
    mockResource = { kind: "project-file", relPath: "src/a.ts" }
  })

  it("provides a bounded flex column so the composer stays visible below suggestions", async () => {
    render(<ResourceWorkbenchChatPanel />)

    expect((await screen.findByTestId("chat-pane")).parentElement).toHaveClass(
      "flex",
      "min-h-0",
      "flex-1",
      "flex-col",
      "overflow-hidden"
    )
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

  it("forwards pre-search sources through its scoped embedded session", async () => {
    render(<ResourceWorkbenchChatPanel />)
    await userEvent.click(await screen.findByRole("button", { name: "send web" }))
    expect(send).toHaveBeenCalledWith("web", undefined, {
      sessionId: "resource-session",
      resourceContext: "",
      attachmentManifest: undefined,
      webSearchContext: {
        provider: "tavily",
        results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
      },
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

  it("submits and durably clears a staged spawned-task prompt only in a multi-aside host", async () => {
    mockSession = {
      id: "resource-session",
      title: "Fix the stream",
      spawnedTask: { mode: "aside", pendingPrompt: "# Fix the stream" },
    }

    const view = render(<ResourceWorkbenchChatPanel />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(send).not.toHaveBeenCalled()

    view.rerender(<ResourceWorkbenchChatPanel multiAside />)
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("# Fix the stream", undefined, {
        sessionId: "resource-session",
        resourceContext: "",
      })
    )
    expect(updateSession).toHaveBeenCalledWith("resource-session", {
      spawnedTask: { mode: "aside" },
    })
  })

  it("clears a stale staged prompt without resubmitting it after a completed turn", async () => {
    mockSession = {
      id: "resource-session",
      title: "Fix the stream",
      lastMessageAt: new Date("2026-08-04T00:00:00.000Z"),
      spawnedTask: { mode: "aside", pendingPrompt: "# Fix the stream" },
    }

    render(<ResourceWorkbenchChatPanel multiAside />)

    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("resource-session", {
        spawnedTask: { mode: "aside" },
      })
    )
    expect(send).not.toHaveBeenCalled()
  })

  it("keeps spawned tasks isolated from the main thread's live resource context", async () => {
    mockSession = {
      id: "resource-session",
      title: "Fix the stream",
      spawnedTask: { mode: "inherit" },
    }

    render(<ResourceWorkbenchChatPanel getResourceContext={() => "main thread transcript"} />)
    await userEvent.click(screen.getByRole("button", { name: "send" }))

    expect(send).toHaveBeenCalledWith("hello", undefined, {
      sessionId: "resource-session",
      resourceContext: "",
      attachmentManifest,
    })
  })

  // ── multi-aside opt-in ──────────────────────────────────────────────────────

  it("renders the aside picker only when the host asks for it", () => {
    // A conversation can own several named asides; an artifact / canvas /
    // project-file chat is a property OF that resource and stays single, so it
    // gets no picker.
    const { rerender } = render(<ResourceWorkbenchChatPanel />)
    expect(screen.queryByTestId("aside-switcher")).not.toBeInTheDocument()

    rerender(<ResourceWorkbenchChatPanel multiAside />)
    fireEvent.click(screen.getByTestId("aside-switcher"))
    expect(setSessionOverride).toHaveBeenCalledWith(expect.any(String), null)
  })

  it("no mobile surface hosts the aside switcher", () => {
    // Three-axis dormancy marking (project rule 7). `components/mobile/` mounts
    // no workbench at all — the only mobile context-workbench is the workflow
    // editor's sheet — so the whole panel, picker included, is desktop-only.
    // If a mobile host ever appears, this assertion is the thing that fails and
    // forces the decision to be re-made rather than inherited by accident.
    const fs = jest.requireActual("node:fs") as typeof import("node:fs")
    const path = jest.requireActual("node:path") as typeof import("node:path")
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        return e.isDirectory() ? walk(p) : [p]
      })
    const mobileSources = walk(path.join(process.cwd(), "components/mobile")).filter((f) =>
      /\.tsx?$/.test(f)
    )
    const hosts = mobileSources.filter((f) =>
      /ResourceWorkbenchChatPanel|AsideSwitcher/.test(fs.readFileSync(f, "utf8"))
    )
    expect(hosts).toEqual([])
  })
})
