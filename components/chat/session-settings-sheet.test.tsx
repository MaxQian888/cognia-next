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

// Fork + active-session + toast are exercised by the fork action test.
jest.mock("@/lib/db/sessions", () => ({
  forkSessionFromParent: jest.fn(async () => ({ id: "fork_1" })),
}))

const setActiveSessionMock = jest.fn()
// Mutable so a test can stage ad-hoc (ephemeral) skill attachments; reset in
// beforeEach. Read lazily inside the selector, so no factory-eval TDZ.
let mockEphemeralSkillIds: string[] = []
jest.mock("@/stores/chat", () => {
  const useChatStore = (selector?: (s: { ephemeralSkillIds: string[] }) => unknown) => {
    const state = { ephemeralSkillIds: mockEphemeralSkillIds }
    return selector ? selector(state) : state
  }
  useChatStore.getState = () => ({ setActiveSession: setActiveSessionMock })
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
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { isTauri } from "@/lib/tauri"
import { closeSession } from "@/lib/claude/ipc"
import { forkSessionFromParent } from "@/lib/db/sessions"

const mockOpenDialog = openDialog as unknown as jest.Mock
const mockIsTauri = isTauri as unknown as jest.Mock
const mockCloseSession = closeSession as unknown as jest.Mock
const mockFork = forkSessionFromParent as unknown as jest.Mock
import type { ReactNode } from "react"
import { SessionSettingsSheet } from "./session-settings-sheet"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import type { ChatSession, Character, SystemPromptPreset, Skill } from "@/lib/claude/types"

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
    mockFork.mockResolvedValue({ id: "fork_1" })
    setActiveSessionMock.mockClear()
    mockEphemeralSkillIds = []
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

  it("renders the fork action only when the session has an sdk session id", () => {
    const adapter = makeAdapter()
    const { rerender } = render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet session={mkSession()} open onOpenChange={jest.fn()} />
      </DataAdapterProvider>
    )
    expect(screen.queryByRole("button", { name: /fork session/i })).not.toBeInTheDocument()
    rerender(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    expect(screen.getByRole("button", { name: /fork session/i })).toBeInTheDocument()
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

  it("forks the session and switches to the new branch", async () => {
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ id: "ses_fork", sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /fork session/i }))
    })
    await waitFor(() => expect(mockFork).toHaveBeenCalledWith("ses_fork"))
    await waitFor(() => expect(setActiveSessionMock).toHaveBeenCalledWith("fork_1"))
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
    fireEvent.click(await screen.findByRole("option", { name: "plan" }))
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

  it("surfaces a toast when forking fails", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    mockFork.mockRejectedValueOnce(new Error("boom"))
    const adapter = makeAdapter()
    render(
      <DataAdapterProvider adapter={adapter}>
        <SessionSettingsSheet
          session={mkSession({ sdkSessionId: "sdk_1" })}
          open
          onOpenChange={jest.fn()}
        />
      </DataAdapterProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /fork session/i }))
    })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"))
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
