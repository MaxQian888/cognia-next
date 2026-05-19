/**
 * @jest-environment jsdom
 *
 * Phase 3 — composer additions:
 *   - mobile-only inline @-mention popover (props.mobileMentionMembers)
 *   - per-session draft persistence (Dexie chatDrafts table)
 *
 * Desktop behaviors (no mobileMentionMembers, no session) must remain
 * unchanged — covered by the existing `composer.test.tsx` regressions.
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
jest.mock("./composer/screenshot-button", () => ({
  ScreenshotButton: () => null,
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { setDraft } from "@/lib/db/chat-drafts"
import type { ChatSession, Character } from "@/lib/claude/types"

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

describe("Composer — desktop regression (no mobile props)", () => {
  it("does not mount the mobile mention popover container when mobileMentionMembers is undefined", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    expect(screen.queryByTestId("mobile-mention-popover")).toBeNull()
  })
})

describe("Composer — mobile mention popover", () => {
  it("opens the mobile popover when the user types @ and mobileMentionMembers is set", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
          mobileMentionMembers={[mkChar("c1", "Alice"), mkChar("c2", "Bob")]}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "@" } })
    expect(screen.getByTestId("mobile-mention-popover")).toBeInTheDocument()
    expect(screen.getByText("Alice")).toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
  })

  it("filters the popover by the @ token query", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
          mobileMentionMembers={[mkChar("c1", "Alice"), mkChar("c2", "Bob")]}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "@al" } })
    expect(screen.getByText("Alice")).toBeInTheDocument()
    expect(screen.queryByText("Bob")).not.toBeInTheDocument()
  })

  it("inserts @<name> when a row is tapped and closes the popover", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
          mobileMentionMembers={[mkChar("c1", "Alice")]}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "@" } })
    fireEvent.click(screen.getByRole("button", { name: /alice/i }))
    await waitFor(() => {
      expect(ta.value).toMatch(/^@Alice\s/)
    })
    expect(screen.queryByTestId("mobile-mention-popover")).toBeNull()
  })

  it("dismisses on Escape (replaces the legacy hand-rolled backdrop click)", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
          mobileMentionMembers={[mkChar("c1", "Alice")]}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea")! as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "@" } })
    expect(screen.getByTestId("mobile-mention-popover")).toBeInTheDocument()
    // The popover was migrated from a hand-rolled overlay+backdrop button
    // to shadcn Sheet, which dismisses via Escape / outside-click via the
    // Radix overlay. Asserting Escape covers the same UX contract without
    // depending on Radix's internal overlay markup.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" })
    await Promise.resolve()
    expect(screen.queryByTestId("mobile-mention-popover")).toBeNull()
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
})
