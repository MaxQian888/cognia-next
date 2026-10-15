import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceWorkbenchChatPanel } from "./resource-workbench-chat-panel"
import { useChatStore } from "@/stores/chat"
import { listMessages } from "@/lib/db/messages"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"

const send = jest.fn().mockResolvedValue(undefined)
const stop = jest.fn()
const regenerate = jest.fn()
const editAndResend = jest.fn()
const exportRun = jest.fn()
const templateRun = {
  templateId: "review",
  version: "1",
  text: "Review {{target}}",
  params: { target: { kind: "text" as const, value: "workflow" } },
}

const attachmentManifest: readonly AttachmentManifestEntry[] = [
  { filename: "report.txt", mediaType: "text/plain", kind: "document" },
]
let mockScopeId = "resource-session"
let mockResource: Record<string, unknown> = { kind: "project-file", relPath: "src/a.ts" }
let mockSession: Record<string, unknown> = { id: "resource-session", title: "Resource" }
const updateSession = jest.fn().mockResolvedValue(undefined)
const setSessionOverride = jest.fn()
let mockParentSession: Record<string, unknown> | undefined
let mockParentRuntime: AgentRuntimeRef = { kind: "builtin" }
let mockParentFusionMode = "auto"
const mockRuntimeState = {
  sessionCompositions: {} as Record<string, { presetId: string; orchestration?: string }>,
  defaultComposition: { presetId: "standard" },
}
const mockExternalState = {
  agents: {} as Record<string, { name: string; protocol: string }>,
  connectionStatus: {} as Record<string, string>,
}
const mockAppSettings = { permissionMode: "default" }
const resolveParentPermission = jest.fn()
const resolveAsideReadOnly = jest.fn()
const resolveAsideRuntime = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { agent?: string }) =>
    values?.agent ? `${key}:${values.agent}` : key,
}))
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => mockParentRuntime,
  useAgentRuntimeStore: (selector: (state: typeof mockRuntimeState) => unknown) =>
    selector(mockRuntimeState),
}))
jest.mock("@/stores/chat/fusion-mode-store", () => ({
  useChatFusionMode: () => mockParentFusionMode,
}))
jest.mock("@/stores/agent", () => ({
  useExternalAgentStore: (selector: (state: typeof mockExternalState) => unknown) =>
    selector(mockExternalState),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { settings: typeof mockAppSettings }) => unknown) =>
    selector({ settings: mockAppSettings }),
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSessionAsideParentPermission: (...args: unknown[]) => resolveParentPermission(...args),
  resolveSessionAsideReadOnly: (...args: unknown[]) => resolveAsideReadOnly(...args),
}))
jest.mock("@/lib/context-workbench/session-aside-runtime", () => ({
  resolveSessionAsideRuntimeWithAgent: (...args: unknown[]) => resolveAsideRuntime(...args),
}))
jest.mock("@/hooks/data/use-single-export", () => ({
  useSingleExport: () => ({ run: exportRun, busy: false }),
}))
jest.mock("./context-workbench", () => ({
  useContextWorkbench: () => ({
    resource: mockResource,
  }),
}))

jest.mock("@/components/chat/chat-scope-provider", () => ({
  useChatScope: () => ({ sessionId: mockScopeId }),
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
  useLiveQuery: (_query: unknown, dependencies: unknown[]) =>
    dependencies[0] === mockScopeId ? mockSession : mockParentSession,
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
      <button type="button" onClick={() => void onSend("Review workflow", undefined, templateRun)}>
        send template
      </button>
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

beforeEach(() => {
  mockParentSession = undefined
  mockParentRuntime = { kind: "builtin" }
  mockParentFusionMode = "auto"
  mockRuntimeState.sessionCompositions = {}
  mockExternalState.agents = {}
  mockExternalState.connectionStatus = {}
  resolveParentPermission.mockReset().mockResolvedValue({ permissionMode: "default" })
  resolveAsideReadOnly
    .mockReset()
    .mockImplementation(
      async (session, permission) =>
        session.asideWriteAccess !== true || permission?.permissionMode === "plan"
    )
  resolveAsideRuntime.mockReset().mockResolvedValue({
    runtimeRef: { kind: "builtin" },
    usesBuiltinFallback: false,
    permissionCeiling: { permissionMode: "plan" },
  })
})

describe("ResourceWorkbenchChatPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockScopeId = "resource-session"
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

  it("preserves template provenance on the scoped user turn", async () => {
    render(<ResourceWorkbenchChatPanel />)
    await userEvent.click(await screen.findByRole("button", { name: "send template" }))
    expect(send).toHaveBeenCalledWith(
      "Review workflow",
      undefined,
      expect.objectContaining({
        sessionId: "resource-session",
        templateRun,
      })
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

  it("supplies parent context again after a spawned task first prompt is consumed", async () => {
    mockSession = {
      id: "resource-session",
      title: "Fix the stream",
      spawnedTask: { mode: "inherit" },
    }

    render(<ResourceWorkbenchChatPanel getResourceContext={() => "main thread transcript"} />)
    await userEvent.click(screen.getByRole("button", { name: "send" }))

    expect(send).toHaveBeenCalledWith("hello", undefined, {
      sessionId: "resource-session",
      resourceContext: "main thread transcript",
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

it("requires confirmation before enabling edits and persists the per-aside choice", async () => {
  jest.clearAllMocks()
  mockResource = { kind: "session", sessionId: "main" }
  mockSession = { id: "resource-session", title: "Aside" }
  const view = render(<ResourceWorkbenchChatPanel />)
  await userEvent.click(screen.getByRole("button", { name: "asides.readOnly" }))
  expect(updateSession).not.toHaveBeenCalled()
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "asides.enableEditing" }))
  expect(updateSession).toHaveBeenCalledWith("resource-session", { asideWriteAccess: true })
  mockSession = { ...mockSession, asideWriteAccess: true }
  view.rerender(<ResourceWorkbenchChatPanel />)
  await userEvent.click(screen.getByRole("button", { name: "asides.canEdit" }))
  expect(updateSession).toHaveBeenLastCalledWith("resource-session", { asideWriteAccess: false })
})

it("regenerates session-bound asides without replacing the controller's cached context", async () => {
  jest.clearAllMocks()
  mockResource = { kind: "session", sessionId: "main" }
  mockSession = { id: "resource-session", title: "Aside" }
  const read = jest.fn(() => "changed parent")
  render(<ResourceWorkbenchChatPanel getResourceContext={read} />)
  await userEvent.click(await screen.findByRole("button", { name: "regenerate" }))
  expect(regenerate).toHaveBeenCalledWith("resource-session", undefined)
  expect(read).not.toHaveBeenCalled()
})

it("does not carry an editing confirmation to another aside", async () => {
  jest.clearAllMocks()
  mockScopeId = "resource-session"
  mockResource = { kind: "session", sessionId: "main" }
  mockSession = { id: mockScopeId, title: "Aside" }
  const view = render(<ResourceWorkbenchChatPanel />)
  await userEvent.click(screen.getByRole("button", { name: "asides.readOnly" }))
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  mockScopeId = "other-aside"
  mockSession = { id: mockScopeId, title: "Other" }
  view.rerender(<ResourceWorkbenchChatPanel />)
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  expect(updateSession).not.toHaveBeenCalled()
  mockScopeId = "resource-session"
})

describe("side-chat runtime note", () => {
  beforeEach(() => {
    mockScopeId = "resource-session"
    mockResource = { kind: "session", sessionId: "main" }
    mockSession = {
      id: mockScopeId,
      title: "Aside",
      kind: "resource-workbench",
      surfaceBinding: { kind: "session", sessionId: "main" },
    }
    mockParentSession = { id: "main", title: "Main" }
    mockParentRuntime = { kind: "external", agentId: "codex" }
    mockExternalState.agents.codex = { name: "My Codex", protocol: "codex-app-server" }
    mockExternalState.connectionStatus.codex = "connected"
    mockListMessages.mockResolvedValue([])
  })

  it("shows the main agent name only when the shared resolver chooses a read-only built-in fallback", async () => {
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "plan" },
    })
    render(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent(
      "asides.differentAgentReadOnly:My Codex"
    )
    expect(screen.getByRole("button", { name: "asides.readOnly" })).toBeInTheDocument()
    expect(resolveParentPermission).toHaveBeenCalledWith(mockParentSession, mockAppSettings)
    expect(resolveAsideRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { ...mockSession, asideWriteAccess: false },
        parentRuntimeRef: mockParentRuntime,
        parentPermission: { permissionMode: "default" },
        forceBuiltin: false,
      })
    )
  })

  it.each([false, true])(
    "does not show a different-agent note when the same external agent is used (unlocked=%s)",
    async (unlocked) => {
      mockSession = { ...mockSession, asideWriteAccess: unlocked }
      resolveAsideRuntime.mockResolvedValue({
        runtimeRef: mockParentRuntime,
        usesBuiltinFallback: false,
        permissionCeiling: { permissionMode: unlocked ? "default" : "plan" },
      })
      render(<ResourceWorkbenchChatPanel />)
      await waitFor(() => expect(resolveAsideRuntime).toHaveBeenCalled())
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    }
  )

  it("uses the shared parent ceiling when an unlocked aside still has read-only permissions", async () => {
    mockSession = { ...mockSession, asideWriteAccess: true }
    resolveParentPermission.mockResolvedValue({ permissionMode: "plan" })
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "plan" },
    })
    render(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent(
      "asides.differentAgentReadOnly:My Codex"
    )
    expect(resolveAsideRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPermission: { permissionMode: "plan" },
      })
    )
  })

  it("uses the aside's own effective Plan mode before deciding a fallback", async () => {
    mockSession = { ...mockSession, asideWriteAccess: true }
    const ownComposition = { presetId: "plan", authority: "plan" }
    mockRuntimeState.sessionCompositions[mockScopeId] = ownComposition
    resolveAsideReadOnly.mockResolvedValue(true)
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "plan" },
    })
    render(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent(
      "asides.differentAgentReadOnly:My Codex"
    )
    expect(resolveAsideReadOnly).toHaveBeenCalledWith(
      mockSession,
      { permissionMode: "default" },
      mockAppSettings,
      { compositionSelection: ownComposition }
    )
    expect(resolveAsideRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { ...mockSession, asideWriteAccess: false },
      })
    )
  })

  it("labels a non-direct fallback without claiming read-only after editing is enabled", async () => {
    mockSession = { ...mockSession, asideWriteAccess: true }
    mockRuntimeState.sessionCompositions.main = { presetId: "standard", orchestration: "team" }
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "acceptEdits" },
    })
    render(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent("asides.differentAgent:My Codex")
    expect(resolveAsideRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ forceBuiltin: true })
    )
  })

  it.each(["teamId", "squadId"])(
    "uses the parent's %s when deciding the fallback",
    async (executor) => {
      mockParentSession = { ...mockParentSession, [executor]: "main-executor" }
      resolveAsideRuntime.mockResolvedValue({
        runtimeRef: { kind: "builtin" },
        usesBuiltinFallback: true,
        permissionCeiling: { permissionMode: "plan" },
      })
      render(<ResourceWorkbenchChatPanel />)
      await screen.findByRole("status")
      expect(resolveAsideRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ forceBuiltin: true })
      )
    }
  )

  it("refreshes the fallback when the parent's Fusion mode changes", async () => {
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: mockParentRuntime,
      usesBuiltinFallback: false,
      permissionCeiling: { permissionMode: "plan" },
    })
    const view = render(<ResourceWorkbenchChatPanel />)
    await waitFor(() =>
      expect(resolveAsideRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ forceBuiltin: false })
      )
    )
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "plan" },
    })
    mockParentFusionMode = "panel"
    view.rerender(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent("My Codex")
    expect(resolveAsideRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceBuiltin: true })
    )
  })

  it("refreshes the note after external capabilities are renegotiated", async () => {
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "plan" },
    })
    const view = render(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent("My Codex")
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: mockParentRuntime,
      usesBuiltinFallback: false,
      permissionCeiling: { permissionMode: "plan" },
    })
    mockExternalState.connectionStatus.codex = "reconnected"
    view.rerender(<ResourceWorkbenchChatPanel />)
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("uses a host agent's display name for an unattested read-only fallback", async () => {
    mockParentRuntime = {
      kind: "host",
      configId: "host-codex",
      revision: "1",
      lifecycleGeneration: 1,
      name: "Host Codex",
    }
    resolveAsideRuntime.mockResolvedValue({
      runtimeRef: { kind: "builtin" },
      usesBuiltinFallback: true,
      permissionCeiling: { permissionMode: "plan" },
    })
    render(<ResourceWorkbenchChatPanel />)
    expect(await screen.findByRole("status")).toHaveTextContent(
      "asides.differentAgentReadOnly:Host Codex"
    )
  })

  it("omits the note for a main conversation already using the built-in agent", async () => {
    mockParentRuntime = { kind: "builtin" }
    render(<ResourceWorkbenchChatPanel />)
    await screen.findByTestId("chat-pane")
    expect(resolveAsideRuntime).not.toHaveBeenCalled()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})

describe("explicit side chat requests", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    mockScopeId = "chosen-aside"
    mockSession = { id: mockScopeId, kind: "resource-workbench" }
    mockResource = { kind: "session", sessionId: "main" }
    mockListMessages.mockResolvedValue([])
    send.mockResolvedValue(undefined)
    const { useSideChatRequestStore } = await import("@/stores/chat/side-chat-request-store")
    useSideChatRequestStore.setState({ pending: {} })
  })

  it("submits staged questions once through the normal panel send with fresh parent context", async () => {
    const { useSideChatRequestStore } = await import("@/stores/chat/side-chat-request-store")
    const { StrictMode } = await import("react")
    useSideChatRequestStore.getState().enqueue("chosen-aside", "first question")
    useSideChatRequestStore.getState().enqueue("chosen-aside", "second question")
    useSideChatRequestStore.getState().enqueue("other-aside", "do not send")
    const context = jest.fn().mockResolvedValue("latest parent context")
    const { rerender } = render(
      <StrictMode>
        <ResourceWorkbenchChatPanel asideTargetSessionId="main" getResourceContext={context} />
      </StrictMode>
    )
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send).toHaveBeenNthCalledWith(
      1,
      "first question",
      undefined,
      expect.objectContaining({
        sessionId: "chosen-aside",
        resourceContext: "latest parent context",
      })
    )
    expect(send).toHaveBeenNthCalledWith(
      2,
      "second question",
      undefined,
      expect.objectContaining({ sessionId: "chosen-aside" })
    )
    rerender(
      <StrictMode>
        <ResourceWorkbenchChatPanel asideTargetSessionId="main" getResourceContext={context} />
      </StrictMode>
    )
    expect(send).toHaveBeenCalledTimes(2)
    expect(stop).not.toHaveBeenCalled()
    expect(useSideChatRequestStore.getState().pending["other-aside"]).toHaveLength(1)
  })

  it("waits for transcript hydration before claiming a staged question", async () => {
    const { useSideChatRequestStore } = await import("@/stores/chat/side-chat-request-store")
    let finishLoad!: (messages: never[]) => void
    mockListMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        finishLoad = resolve
      })
    )
    useSideChatRequestStore.getState().enqueue("chosen-aside", "after hydration")
    render(<ResourceWorkbenchChatPanel asideTargetSessionId="main" />)
    await screen.findByTestId("chat-pane")
    expect(send).not.toHaveBeenCalled()
    expect(useSideChatRequestStore.getState().pending["chosen-aside"]).toHaveLength(1)
    await act(async () => finishLoad([]))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "after hydration",
        undefined,
        expect.objectContaining({ sessionId: "chosen-aside" })
      )
    )
  })

  it("keeps a failed request as an editable draft instead of dropping it", async () => {
    const { useSideChatRequestStore } = await import("@/stores/chat/side-chat-request-store")
    const { useComposerIntentStore } = await import("@/stores/chat/composer-intent-store")
    useComposerIntentStore.setState({ pendingBySession: {} })
    send.mockRejectedValueOnce(new Error("send failed"))
    useSideChatRequestStore.getState().enqueue("chosen-aside", "recover me")
    render(<ResourceWorkbenchChatPanel asideTargetSessionId="main" />)
    await waitFor(() =>
      expect(useComposerIntentStore.getState().pendingBySession["chosen-aside"]?.prompt).toBe(
        "recover me"
      )
    )
    expect(useSideChatRequestStore.getState().pending["chosen-aside"]).toHaveLength(0)
  })
})
