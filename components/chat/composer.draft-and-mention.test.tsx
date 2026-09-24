/**
 * @jest-environment jsdom
 *
 * Phase 3 — composer additions:
 *   - a team room's `@` panel (the room's members, in the combined panel)
 *   - per-session draft persistence (Dexie chatDrafts table)
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
jest.mock("@/lib/files/memory", () => ({
  appendMemory: jest.fn(),
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
// The saved-draft read, with a gate a test can hold shut to type into the box
// while the read is still in flight. Delegates to the real Dexie read.
const mockDraftReadGate: { hold: Promise<void> | null } = { hold: null }
jest.mock("@/lib/db/chat-drafts", () => {
  const actual = jest.requireActual("@/lib/db/chat-drafts")
  return {
    ...actual,
    getDraft: async (...args: unknown[]) => {
      if (mockDraftReadGate.hold) await mockDraftReadGate.hold
      return actual.getDraft(...args)
    },
  }
})
// `mockTeamMembers` is read lazily, inside the hook, so each test can set the
// room it means.
const mockTeamMembers = jest.fn((_teamId: string | null | undefined): unknown[] => [])
jest.mock("@/hooks/use-team-members", () => ({
  useTeamMembers: (teamId: string | null | undefined) => mockTeamMembers(teamId),
  useTeamMemberRoles: () => new Map(),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { setDraft } from "@/lib/db/chat-drafts"
import type { ChatSession, Character } from "@cognia/agent-config-types"

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  Wrapper.displayName = "ComposerDraftMentionWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_dm_1",
  title: "Draft + Mention",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

const mkChar = (id: string, name: string): Character => ({
  id,
  name,
  systemPrompt: "",
  avatarColor: "#000",
  isBuiltIn: false,
  createdAt: 0,
  updatedAt: 0,
})

beforeEach(async () => {
  useChatStore.getState().clear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("Composer — a team room's @ panel", () => {
  // A phone used to swap the combined panel for a members-only sheet, so the
  // same room could `@` a file on desktop and not on a phone. Every surface now
  // gets the one combined panel, which lists the room's members first.
  const members = [mkChar("c1", "Alice"), mkChar("c2", "Bob")]

  function renderRoom() {
    mockTeamMembers.mockImplementation((teamId: string | null | undefined) =>
      teamId === "team_1" ? members : []
    )
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ kind: "team", teamId: "team_1" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    return document.querySelector("textarea")! as HTMLTextAreaElement
  }

  afterEach(() => {
    mockTeamMembers.mockReset()
    mockTeamMembers.mockReturnValue([])
  })

  it("lists the room's members in the combined panel, not a separate sheet", async () => {
    const ta = renderRoom()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "@", selectionStart: 1 } })
    })
    expect(await screen.findByText("Alice")).toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-mention-popover")).toBeNull()
  })

  it("filters the members by the @ query", async () => {
    const ta = renderRoom()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "@al", selectionStart: 3 } })
    })
    expect(await screen.findByText("Alice")).toBeInTheDocument()
    expect(screen.queryByText("Bob")).not.toBeInTheDocument()
  })

  it("inserts @<name> when a member is picked", async () => {
    const ta = renderRoom()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "@al", selectionStart: 3 } })
    })
    await screen.findByText("Alice")
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" })
    })
    await waitFor(() => expect(ta.value).toMatch(/^@Alice\s/))
  })
})

describe("Composer — per-session draft persistence", () => {
  it("restores a saved draft into the textarea when mounting on the matching session", async () => {
    await setDraft("ses_with_draft", "saved text")
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_with_draft" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    await waitFor(() => {
      expect(ta.value).toBe("saved text")
    })
  })

  // The stored draft used to land on top of whatever was typed while it
  // loaded, replacing the message the user was in the middle of writing.
  it("keeps what was typed while the saved draft was still loading", async () => {
    await setDraft("ses_gap", "saved text")
    let release: () => void = () => undefined
    mockDraftReadGate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const Wrapper = withAdapter(makeAdapter())
      render(
        <Wrapper>
          <Composer
            session={mkSession({ id: "ses_gap" })}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </Wrapper>
      )
      const ta = document.querySelector("textarea")! as HTMLTextAreaElement
      await act(async () => {
        fireEvent.change(ta, { target: { value: "typed meanwhile" } })
      })
      await act(async () => {
        release()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(ta.value).toBe("typed meanwhile")
    } finally {
      mockDraftReadGate.hold = null
    }
  })

  it("eventually persists the draft to Dexie after the debounce window", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_debounce" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "hello" } })
    await waitFor(
      async () => {
        const row = await getDb().chatDrafts.get("ses_debounce")
        expect(row?.text).toBe("hello")
      },
      { timeout: 2000 }
    )
  })

  it("restores the right draft when switching between sessions", async () => {
    await setDraft("ses_a", "alpha draft")
    await setDraft("ses_b", "beta draft")
    const Wrapper = withAdapter(makeAdapter())
    const { rerender } = render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_a" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    await waitFor(() => {
      expect(ta.value).toBe("alpha draft")
    })
    rerender(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_b" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    await waitFor(() => {
      expect(ta.value).toBe("beta draft")
    })
  })

  // Regression: the Composer is not remounted per session (no key), so switching
  // to a session that has NO draft must explicitly clear the box — otherwise the
  // previous session's text lingers and gets persisted into the new session.
  it("clears the composer when switching to a session with no draft", async () => {
    await setDraft("ses_has", "carried over text")
    const Wrapper = withAdapter(makeAdapter())
    const { rerender } = render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_has" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    await waitFor(() => {
      expect(ta.value).toBe("carried over text")
    })
    rerender(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_no_draft" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    await waitFor(() => {
      expect(ta.value).toBe("")
    })
    // And the empty session must not have inherited the previous draft's text.
    const bled = await getDb().chatDrafts.get("ses_no_draft")
    expect(bled?.text ?? "").toBe("")
  })
})

describe("Composer — context chips in drafts", () => {
  const chip = {
    kind: "entity" as const,
    entityKind: "memory" as const,
    entityId: "mem_1",
    title: "Prefers pnpm",
    snapshot: "the approved body",
    comment: "",
    capturedAt: 1_000,
  }

  const sessionSelections = (sessionId: string) =>
    useChatStore.getState().sessions[sessionId]?.contextSelections ?? []

  // A chip holds the snapshot and fingerprint itself, so restoring needs no
  // re-read of the source — the draft alone brings the reference back.
  it("restores the staged chips of a chips-only draft", async () => {
    await setDraft("ses_chips", "", [], { contextSelections: [chip] })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_chips" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    await waitFor(() =>
      expect(sessionSelections("ses_chips").map((s) => s.title)).toEqual(["Prefers pnpm"])
    )
  })

  it("skips a stored entry that is not a ContextSelectionRef", async () => {
    await setDraft("ses_bad_chips", "", [], {
      contextSelections: [chip, { kind: "entity" }] as never,
    })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_bad_chips" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    await waitFor(() => expect(sessionSelections("ses_bad_chips")).toHaveLength(1))
    expect(sessionSelections("ses_bad_chips")[0].title).toBe("Prefers pnpm")
  })

  // The save effect subscribes to the chip list: staging a chip without typing
  // still lands in Dexie, and unstaging the last one clears it there.
  it("persists a staged chip and clears it when unstaged", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "ses_live_chips" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    act(() => useChatStore.getState().addContextSelection(chip, "ses_live_chips"))
    await waitFor(
      async () => {
        const row = await getDb().chatDrafts.get("ses_live_chips")
        expect(row?.contextSelections?.map((s) => s.title)).toEqual(["Prefers pnpm"])
      },
      { timeout: 2000 }
    )
    act(() => useChatStore.getState().clearContextSelections("ses_live_chips"))
    await waitFor(
      async () => {
        const row = await getDb().chatDrafts.get("ses_live_chips")
        expect(row?.contextSelections ?? []).toEqual([])
      },
      { timeout: 2000 }
    )
  })
})
