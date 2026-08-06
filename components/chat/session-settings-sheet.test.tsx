// Coverage for SessionSettingsSheet — the consolidated low-frequency session
// settings sheet extracted from chat-header. Verifies the form persists via
// `updateSession`, the working-dir hydration guard survives a background
// session refresh, and the preset list is wired.

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(async () => null),
}))

jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: jest.fn(() => ({ keyOk: true, plan: null })),
}))

jest.mock("@/lib/claude/ipc", () => ({
  closeSession: jest.fn(async () => undefined),
}))

const mockSaveAgentEnvSecret = jest.fn(async () => undefined)
jest.mock("@/lib/agent/agent-env-keyring", () => ({
  createAgentEnvSecretRef: (sessionId: string, name: string) => `${sessionId}:${name}:new`,
  saveAgentEnvSecret: (secretRef: string, value: string) =>
    mockSaveAgentEnvSecret(secretRef, value),
}))

jest.mock("@/components/chat/dialogs/clear-conversation-trigger", () => ({
  ClearConversationTrigger: () => null,
}))

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))

jest.mock("./header-account-switcher", () => ({
  HeaderAccountSwitcher: () => <div data-testid="account-switcher" />,
}))

jest.mock("@/components/chat/dialogs/single-export-trigger", () => ({
  SingleExportTrigger: () => null,
}))

// Branch + active-session + toast are exercised by the branch action tests.
jest.mock("@/lib/chat/branch-session", () => ({
  branchSessionAtMessage: jest.fn(async () => ({ id: "branch_1" })),
}))

const setActiveSessionMock = jest.fn()
// The sheet branches from the target session's OWN slice, so the store mock has
// to expose one rather than only the top-level active projection.
let mockSessionSlices: Record<string, { messages: unknown[]; activeBranchByGroup: object }> = {}
// Mutable so a test can stage ad-hoc (ephemeral) skill attachments; reset in
// beforeEach. Read lazily inside the selector, so no factory-eval TDZ.
let mockEphemeralSkillIds: string[] = []
jest.mock("@/stores/chat", () => {
  const useChatStore = (selector?: (s: { ephemeralSkillIds: string[] }) => unknown) => {
    const state = { ephemeralSkillIds: mockEphemeralSkillIds }
    return selector ? selector(state) : state
  }
  useChatStore.getState = () => ({
    setActiveSession: setActiveSessionMock,
    sessions: mockSessionSlices,
    activeSessionId: null,
    messages: [],
    activeBranchByGroup: {},
  })
  return { useChatStore }
})

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

// Ambient-status cluster (rendered only when `showAmbientStatus` — the mobile
// path that relocates the dropped ChatHeader's affordances here).
jest.mock("@/components/chat/session-cost-badge-live", () => ({
  SessionCostBadgeLive: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="cost-badge">{sessionId}</div>
  ),
}))
jest.mock("@/components/agent/workspace/plan-mode-tasks-sheet", () => ({
  PlanModeTasksSheet: () => <div data-testid="plan-tasks" />,
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => <div data-testid="plugin-slot" />,
}))

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { isTauri } from "@/lib/tauri"
import { closeSession } from "@/lib/claude/ipc"
import { branchSessionAtMessage } from "@/lib/chat/branch-session"

const mockOpenDialog = openDialog as unknown as jest.Mock
const mockIsTauri = isTauri as unknown as jest.Mock
const mockCloseSession = closeSession as unknown as jest.Mock
const mockBranch = branchSessionAtMessage as unknown as jest.Mock
import type { ReactNode } from "react"
import { SessionSettingsSheet } from "./session-settings-sheet"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { ChatSession, Character, SystemPromptPreset, Skill } from "@cognia/agent-config-types"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

const mockCredentialStatus = useCredentialStatus as unknown as jest.Mock

const STABLE_EMPTY_SKILLS: Skill[] = []
const STABLE_EMPTY_PRESETS: SystemPromptPreset[] = []

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => [],
    useCharacter: () => undefined,
    useSkillsByIds: () => STABLE_EMPTY_SKILLS,
    usePresets: () => STABLE_EMPTY_PRESETS,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>{children}</DataAdapterProvider>
  )
  Wrapper.displayName = "SheetTestWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_1",
  title: "Untitled",
  kind: "direct",
  characterId: undefined,
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

const mkCharacter = (overrides: Partial<Character> = {}): Character => ({
  id: "c1",
  name: "Char",
  avatarColor: "#3b82f6",
  systemPrompt: "...",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("SessionSettingsSheet", () => {
  beforeEach(() => {
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: null })
    mockIsTauri.mockReturnValue(false)
    mockOpenDialog.mockResolvedValue(null)
    mockCloseSession.mockResolvedValue(undefined)
    mockBranch.mockResolvedValue({ id: "branch_1" })
    mockSaveAgentEnvSecret.mockClear()
    mockSessionSlices = {}
    setActiveSessionMock.mockClear()
    mockEphemeralSkillIds = []
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })

  it("renders nothing interactive when closed", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <SessionSettingsSheet session={mkSession()} open={false} onOpenChange={jest.fn()} />
      </Wrapper>
    )
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument()
  })

  it("renders the form sections when open", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </Wrapper>
    )
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/working directory/i)).toBeInTheDocument()
    expect(screen.getByTestId("account-switcher")).toBeInTheDocument()
  })

  it("omits the ambient status cluster on desktop (showAmbientStatus unset)", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </Wrapper>
    )
    expect(screen.queryByTestId("session-ambient-status")).not.toBeInTheDocument()
  })

  it("renders the ambient status cluster (cost / plan-tasks / plugin slot) when showAmbientStatus is set (mobile)", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <SessionSettingsSheet
          session={mkSession()}
          open
          onOpenChange={jest.fn()}
          showAmbientStatus
        />
      </Wrapper>
    )
    expect(screen.getByTestId("session-ambient-status")).toBeInTheDocument()
    expect(screen.getByTestId("cost-badge")).toHaveTextContent("ses_1")
    expect(screen.getByTestId("plan-tasks")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-slot")).toBeInTheDocument()
  })

  it("shows the effective Agent model and execution summary on mobile", () => {
    const character = mkCharacter({
      id: "agent-1",
      model: "legacy-execute",
      modelRouting: { plan: "planner", execute: "executor", utility: "fast" },
      executionPolicy: { effort: "medium", maxTurns: 20 },
    })
    const adapter = makeAdapter({ useCharacter: () => character })

    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({
            characterId: "agent-1",
            executionPolicy: { maxTurns: 8 },
          })}
          open
          onOpenChange={jest.fn()}
          showAmbientStatus
        />
      </DataAdapterProvider>
    )

    const summary = screen.getByTestId("agent-execution-summary")
    expect(summary).toHaveTextContent("planner")
    expect(summary).toHaveTextContent("executor")
    expect(summary).toHaveTextContent("fast")
    expect(summary).toHaveTextContent("medium")
    expect(summary).toHaveTextContent("8")
  })

  it("persists session execution overrides", async () => {
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({
            id: "ses_exec",
            effort: "high",
            executionPolicy: {
              maxTurns: 12,
              envBindings: [{ name: "MODE", kind: "plain", value: "safe" }],
            },
          })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )

    expect(screen.getByRole("combobox", { name: /execution effort/i })).toHaveTextContent("High")
    expect(screen.getByRole("spinbutton", { name: /maximum turns/i })).toHaveValue(12)
    expect(screen.getByRole("textbox", { name: /environment variable name/i })).toHaveValue("MODE")
    expect(screen.getByRole("textbox", { name: /environment variable value/i })).toHaveValue("safe")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }))
    })

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    expect(updateSession.mock.calls[0][1]).toMatchObject({
      effort: "high",
      executionPolicy: {
        maxTurns: 12,
        envBindings: [{ name: "MODE", kind: "plain", value: "safe" }],
      },
    })
  })

  it("preserves an untouched composite thinking level while saving execution overrides", async () => {
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    render(
      <DataAdapterProvider adapter={makeAdapter({ updateSession })}>
        <SessionSettingsSheet
          session={mkSession({
            effort: "xhigh",
            thinkingLevel: "ultracode",
            executionPolicy: { maxTurns: 6 },
          })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }))
    })

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    expect(updateSession.mock.calls[0][1]).toMatchObject({
      effort: "xhigh",
      thinkingLevel: "ultracode",
      executionPolicy: { maxTurns: 6 },
    })
  })

  it("updates a session secret in the keyring without persisting its value", async () => {
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    const secretBinding = {
      name: "TOKEN",
      kind: "secret" as const,
      secretRef: "ses_secret:TOKEN",
    }
    render(
      <DataAdapterProvider adapter={makeAdapter({ updateSession })}>
        <SessionSettingsSheet
          session={mkSession({
            id: "ses_secret",
            executionPolicy: { envBindings: [secretBinding] },
          })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )

    fireEvent.change(screen.getByLabelText(/environment variable value/i), {
      target: { value: "super-secret" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }))
    })

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    expect(mockSaveAgentEnvSecret).toHaveBeenCalledWith("ses_secret:TOKEN", "super-secret")
    expect(updateSession.mock.calls[0][1]).toMatchObject({
      executionPolicy: { envBindings: [secretBinding] },
    })
    expect(JSON.stringify(updateSession.mock.calls[0][1])).not.toContain("super-secret")
  })

  it("Save calls updateSession with the session id and closes the sheet", async () => {
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    const onOpenChange = jest.fn()
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_42" })}
          open
          onOpenChange={onOpenChange}
        />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }))
    })
    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    expect(updateSession.mock.calls[0][0]).toBe("ses_42")
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("Cancel closes the sheet without persisting", () => {
    const updateSession = jest.fn(async () => undefined)
    const onOpenChange = jest.fn()
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={onOpenChange} />
      </DataAdapterProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("typed working dir survives a background session refresh while open", async () => {
    const adapter = makeAdapter()
    let session = mkSession({ id: "ses_42", workingDir: "/old" })
    const { rerender } = render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={session} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    const input = (await screen.findByLabelText(/working directory/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: "/new" } })
    expect(input.value).toBe("/new")

    // touchSession bumps updatedAt during a parallel send → new session ref.
    session = { ...session, updatedAt: 123 }
    await act(async () => {
      rerender(
        <DataAdapterProvider adapter={adapter}>
          <SessionSettingsSheet session={session} open onOpenChange={jest.fn()} />
        </DataAdapterProvider>
      )
    })
    const after = (await screen.findByLabelText(/working directory/i)) as HTMLInputElement
    expect(after.value).toBe("/new")
  })

  it("renders the preset Select when presets resolve", async () => {
    const presets: SystemPromptPreset[] = [
      {
        id: "p1",
        name: "p-one",
        content: "hello",
        isBuiltIn: false,
        isDefault: false,
        isFavorite: false,
        sortOrder: 0,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const adapter = makeAdapter({ usePresets: () => presets })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    await waitFor(() => expect(document.getElementById("session-preset")).not.toBeNull())
  })

  it("renders the subscription tier badge when on a subscription plan", () => {
    mockCredentialStatus.mockReturnValue({ keyOk: true, plan: "max" })
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    expect(screen.getByText(/Max plan/i)).toBeInTheDocument()
  })

  it("offers the branch action with or without an sdk session id", () => {
    // This used to be gated on `sdkSessionId` because the old SDK-level fork had
    // nothing to fork from without one — which hid the action entirely on every
    // provider that never issues an SDK session id. Branching re-establishes
    // context from the transcript instead, so it is always available.
    const adapter = makeAdapter()
    const { rerender } = render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    expect(screen.getByRole("button", { name: /branch conversation/i })).toBeInTheDocument()
    rerender(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    expect(screen.getByRole("button", { name: /branch conversation/i })).toBeInTheDocument()
  })

  it("renders the skills badge when the character has resolved skills", () => {
    const c = mkCharacter({ id: "c1", skillIds: ["s1"] })
    const skill: Skill = { id: "s1", name: "skill-x", content: "...", createdAt: 0, updatedAt: 0 }
    const adapter = makeAdapter({ useCharacter: () => c, useSkillsByIds: () => [skill] })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ characterId: "c1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    expect(screen.getByLabelText(/skills active/i)).toBeInTheDocument()
  })

  it("renders the skills badge from ad-hoc attachments even when the character has none", () => {
    mockEphemeralSkillIds = ["e1"]
    const c = mkCharacter({ id: "c1" }) // no character skillIds
    const ephSkill: Skill = { id: "e1", name: "ad-hoc", content: "...", createdAt: 0, updatedAt: 0 }
    const adapter = makeAdapter({
      useCharacter: () => c,
      // Args-aware: character resolves to none, ephemeral resolves to the attachment.
      useSkillsByIds: (ids?: readonly string[]) => (ids?.includes("e1") ? [ephSkill] : []),
    })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ characterId: "c1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    expect(screen.getByLabelText(/skills active/i)).toBeInTheDocument()
  })

  it("toggling a skill off persists disabledSkillIds via updateSession", async () => {
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    const c = mkCharacter({ id: "c1", skillIds: ["s1"] })
    const skill: Skill = { id: "s1", name: "skill-x", content: "...", createdAt: 0, updatedAt: 0 }
    const adapter = makeAdapter({
      updateSession,
      useCharacter: () => c,
      useSkillsByIds: () => [skill],
    })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_9", characterId: "c1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    fireEvent.click(screen.getByLabelText(/skills active/i))
    const sw = await screen.findByRole("switch", { name: /skill-x/i })
    fireEvent.click(sw) // enabled → off
    await waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith("ses_9", { disabledSkillIds: ["s1"] })
    )
  })

  it("persists independent per-chat memory use and learning overrides", async () => {
    const user = userEvent.setup()
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    render(
      <DataAdapterProvider adapter={makeAdapter({ updateSession })}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_memory" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )

    await user.click(screen.getByRole("combobox", { name: /use memories in this chat/i }))
    await user.click(screen.getByRole("option", { name: /^off$/i }))
    await user.click(screen.getByRole("combobox", { name: /learn from this chat/i }))
    await user.click(screen.getByRole("option", { name: /^on$/i }))

    expect(updateSession).toHaveBeenCalledWith("ses_memory", { memoryUse: false })
    expect(updateSession).toHaveBeenCalledWith("ses_memory", { memoryLearn: true })
  })

  it("picks a working directory via the Tauri folder dialog", async () => {
    mockIsTauri.mockReturnValue(true)
    mockOpenDialog.mockResolvedValueOnce("/picked/dir")
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /pick directory/i }))
    })
    const input = (await screen.findByLabelText(/working directory/i)) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe("/picked/dir"))
  })

  it("closes the sidecar session when the working dir changes on save (Tauri + sdk session)", async () => {
    mockIsTauri.mockReturnValue(true)
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_cwd", workingDir: "/old", sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    const input = (await screen.findByLabelText(/working directory/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: "/new" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }))
    })
    await waitFor(() => expect(mockCloseSession).toHaveBeenCalledWith("ses_cwd"))
  })

  it("branches at the last visible message and switches to the new conversation", async () => {
    mockSessionSlices = {
      ses_branch: {
        messages: [
          { id: "m1", role: "user", parts: [] },
          { id: "m2", role: "assistant", parts: [] },
        ],
        activeBranchByGroup: {},
      },
    }
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_branch", sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /branch conversation/i }))
    })
    // Tail cut-off + direct mode — `branchSessionAtMessage` reuses the cheap SDK
    // fork internally when the parent has an sdkSessionId, so this is a superset
    // of the old fork path rather than a different operation.
    await waitFor(() =>
      expect(mockBranch).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "ses_branch", messageId: "m2", mode: "direct" })
      )
    )
    await waitFor(() => expect(setActiveSessionMock).toHaveBeenCalledWith("branch_1"))
  })

  it("refuses to branch a conversation that has no messages yet", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_empty" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /branch conversation/i }))
    })
    expect(mockBranch).not.toHaveBeenCalled()
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("applies a non-conflicting preset into the form (fill-empty)", async () => {
    const recordPresetUsage = jest.fn(async () => undefined)
    const presets: SystemPromptPreset[] = [
      {
        id: "p1",
        name: "fillp",
        content: "preset body",
        isBuiltIn: false,
        isDefault: false,
        isFavorite: false,
        sortOrder: 0,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const adapter = makeAdapter({ usePresets: () => presets, recordPresetUsage })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    fireEvent.click(document.getElementById("session-preset")!)
    fireEvent.click(await screen.findByRole("option", { name: /fillp/ }))
    // fill-empty into an empty session writes the preset body into the prompt.
    const prompt = (await screen.findByLabelText(/system prompt/i)) as HTMLTextAreaElement
    await waitFor(() => expect(prompt.value).toBe("preset body"))
    expect(recordPresetUsage).toHaveBeenCalledWith("p1")
  })

  it("opens the conflict dialog when a preset would overwrite a set field, and applies on confirm", async () => {
    const recordPresetUsage = jest.fn(async () => undefined)
    const presets: SystemPromptPreset[] = [
      {
        id: "p2",
        name: "confp",
        content: "different body",
        isBuiltIn: false,
        isDefault: false,
        isFavorite: false,
        sortOrder: 0,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const adapter = makeAdapter({ usePresets: () => presets, recordPresetUsage })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ systemPrompt: "existing prompt" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    fireEvent.click(document.getElementById("session-preset")!)
    fireEvent.click(await screen.findByRole("option", { name: /confp/ }))
    // Conflict dialog appears (preset would overwrite the set system prompt).
    const apply = await screen.findByRole("button", { name: /^apply$/i })
    fireEvent.click(apply)
    await waitFor(() => expect(recordPresetUsage).toHaveBeenCalledWith("p2"))
  })

  it("clears the system prompt when switching the preset back to (none)", async () => {
    const presets: SystemPromptPreset[] = [
      {
        id: "p3",
        name: "somep",
        content: "body",
        isBuiltIn: false,
        isDefault: false,
        isFavorite: false,
        sortOrder: 0,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const adapter = makeAdapter({ usePresets: () => presets })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    const prompt = (await screen.findByLabelText(/system prompt/i)) as HTMLTextAreaElement
    // First apply a real preset (fill-empty into an empty session).
    fireEvent.click(document.getElementById("session-preset")!)
    fireEvent.click(await screen.findByRole("option", { name: /somep/ }))
    await waitFor(() => expect(prompt.value).toBe("body"))
    // Now switch back to (none) — a real value change that fires the handler.
    fireEvent.click(document.getElementById("session-preset")!)
    fireEvent.click(await screen.findByRole("option", { name: /^\(none\)$/ }))
    await waitFor(() => expect(prompt.value).toBe(""))
  })

  it("persists toggled session modes and the chosen permission mode on save", async () => {
    const updateSession = jest.fn(async (_id: string, _patch: unknown) => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession({ id: "ses_m" })} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    fireEvent.click(screen.getByRole("switch", { name: /bare mode/i }))
    fireEvent.click(screen.getByRole("switch", { name: /debug mode/i }))
    fireEvent.click(screen.getByRole("switch", { name: /brief output/i }))
    fireEvent.click(document.getElementById("session-perm")!)
    fireEvent.click(await screen.findByRole("option", { name: /^plan$/i }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }))
    })
    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1))
    expect(updateSession.mock.calls[0][1]).toMatchObject({
      bareMode: true,
      debugMode: true,
      briefMode: true,
      permissionMode: "plan",
    })
  })

  // This sheet became the ONLY per-session permission picker when the status
  // bar's popover was removed. Its local mode list had drifted to four entries
  // and omitted `dontAsk` / `auto`, which would have left those two settable
  // app-wide but not for a single session.
  it("offers every permission mode, labelled, with a risk marker on the dangerous one", async () => {
    render(
      <DataAdapterProvider adapter={makeAdapter()}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    fireEvent.click(document.getElementById("session-perm")!)
    for (const label of [/^default$/i, /^accept edits$/i, /^plan$/i, /^auto$/i, /don't ask/i]) {
      expect(await screen.findByRole("option", { name: label })).toBeInTheDocument()
    }
    const bypass = await screen.findByRole("option", { name: /bypass/i })
    expect(bypass).toHaveTextContent("⚠")
  })

  it("resets the working directory via the inline clear button", async () => {
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ workingDir: "/x" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    const input = (await screen.findByLabelText(/working directory/i)) as HTMLInputElement
    expect(input.value).toBe("/x")
    fireEvent.click(screen.getByRole("button", { name: /reset/i }))
    await waitFor(() => expect(input.value).toBe(""))
  })

  it("surfaces a translated toast when branching fails, never the raw Error text", async () => {
    // The old fork path piped `err.message` straight into the toast, putting
    // untranslated internals ("Cannot fork: the session hasn't started a SDK
    // conversation yet") in front of the user.
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    mockSessionSlices = {
      ses_fail: { messages: [{ id: "m1", role: "user", parts: [] }], activeBranchByGroup: {} },
    }
    mockBranch.mockRejectedValueOnce(new Error("boom"))
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_fail", sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /branch conversation/i }))
    })
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalledWith("boom")
  })

  it("shows the active workspace root as the cwd fallback hint (above the character default)", async () => {
    const project = {
      id: "proj-ws",
      name: "WS",
      roots: [{ id: "r1", path: "/ws/root", isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    } as Project
    useProjectStore.setState({ projects: [project], activeProjectId: project.id, loaded: false })
    const adapter = makeAdapter({
      useCharacter: () => mkCharacter({ workingDir: "/char/dir" }),
    })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ characterId: "c1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    // Workspace root outranks the character default, matching the send path.
    expect(await screen.findByText(/\/ws\/root/)).toBeInTheDocument()
    expect(screen.queryByText(/\/char\/dir/)).not.toBeInTheDocument()
  })

  it("falls back to the character default hint when no workspace is active", async () => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
    const adapter = makeAdapter({
      useCharacter: () => mkCharacter({ workingDir: "/char/dir" }),
    })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ characterId: "c1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    expect(await screen.findByText(/\/char\/dir/)).toBeInTheDocument()
  })

  it("dismisses the preset conflict dialog on cancel without applying", async () => {
    const recordPresetUsage = jest.fn(async () => undefined)
    const presets: SystemPromptPreset[] = [
      {
        id: "p4",
        name: "cancelp",
        content: "different",
        isBuiltIn: false,
        isDefault: false,
        isFavorite: false,
        sortOrder: 0,
        usageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]
    const adapter = makeAdapter({ usePresets: () => presets, recordPresetUsage })
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ systemPrompt: "keep me" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    fireEvent.click(document.getElementById("session-preset")!)
    fireEvent.click(await screen.findByRole("option", { name: /cancelp/ }))
    const dialogCancel = await screen.findByRole("button", { name: /^cancel$/i })
    fireEvent.click(dialogCancel)
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument()
    )
    expect(recordPresetUsage).not.toHaveBeenCalled()
  })
})
