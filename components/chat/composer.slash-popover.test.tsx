/**
 * @jest-environment jsdom
 *
 * Integration coverage for the keyboard-driven slash-command popover, exercised
 * through the REAL <Composer>. This is the wiring that `composer-popover.test.tsx`
 * deliberately skips: that suite drives the popover's imperative handle
 * (`navigate`/`confirm`) directly, proving the popover in isolation. Here we prove
 * the composer's own `onKeyDown` (composer.tsx:724) actually routes ArrowDown /
 * ArrowUp / Enter / Escape into that handle, and that picking a command splices
 * `/<cmd> ` back into the textarea (deferred-execution UX) WITHOUT sending a turn.
 *
 * What "various user paths" looks like as tests: one `it()` per path —
 *   type `/`  → popover opens
 *   filter    → only the matching command shows
 *   ArrowDown → highlight moves, Enter confirms the highlighted (not the first) row
 *   Tab       → selects the highlighted row (same confirm path as Enter)
 *   ArrowUp   → highlight wraps to the last row
 *   Enter     → confirms, drops `/cmd ` into the box, sends nothing
 *   Escape    → dismisses the popover, sends nothing
 *   backspace → deleting the `/` dismisses the popover
 */

// Submitting / draft-clearing touches Dexie — provide a real IndexedDB.
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
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
jest.mock("./composer/screenshot-button", () => ({ ScreenshotButton: () => null }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import type { ChatSession } from "@/lib/claude/types"

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

function renderComposer(onSend = jest.fn()) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  const session: ChatSession = {
    id: "ses_slash",
    title: "Slash popover",
    kind: "direct",
    permissionMode: undefined,
    createdAt: 0,
    updatedAt: 0,
    workingDir: "/tmp/work",
  }
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  const ta = document.querySelector("textarea") as HTMLTextAreaElement
  return { ta, onSend }
}

// Type a value into the textarea and let the trigger memo + popover render flush.
async function typeValue(ta: HTMLTextAreaElement, value: string) {
  fireEvent.change(ta, { target: { value } })
  await new Promise((r) => setTimeout(r, 0))
}

const rows = () => screen.queryAllByRole("listitem")
const rowTexts = () => rows().map((li) => li.textContent ?? "")
// The highlighted row gets `bg-accent text-accent-foreground`; the others get the
// `hover:bg-accent/40` variant (composer-popover.tsx:297). Match the highlight-only
// `text-accent-foreground` token — `bg-accent` alone is a substring of both.
const highlightedIndex = () =>
  rows().findIndex((li) => li.className.includes("text-accent-foreground"))
// A slash row renders its name as `/name …` — pull the command name back out.
const nameOf = (text: string) => text.match(/\/([\w-]+)/)?.[1] ?? ""

beforeEach(() => {
  useChatStore.getState().clear()
})

describe("Composer — slash popover (keyboard, end-to-end)", () => {
  it("typing `/` opens the popover with command rows", async () => {
    const { ta } = renderComposer()
    await typeValue(ta, "/")
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(rows().length).toBeGreaterThan(0)
    expect(rowTexts().some((t) => t.startsWith("/"))).toBe(true)
  })

  it("narrows to a single command as the query gets specific", async () => {
    const { ta } = renderComposer()
    await typeValue(ta, "/compac")
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rowTexts()[0]).toContain("/compact")
  })

  it("ArrowDown moves the highlight; Enter confirms the highlighted row (not the first)", async () => {
    const { ta, onSend } = renderComposer()
    // "co" matches several param-less commands (cost / compact / context / …).
    await typeValue(ta, "/co")
    await waitFor(() => expect(rows().length).toBeGreaterThan(1))
    expect(highlightedIndex()).toBe(0) // first row highlighted by default

    fireEvent.keyDown(ta, { key: "ArrowDown" })
    expect(highlightedIndex()).toBe(1) // composer.onKeyDown → popover.navigate(1)

    // Derive the expected command from the rendered order — don't hard-code ranking.
    const expected = nameOf(rowTexts()[1])
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 30))

    // Deferred-execution UX: confirm drops the picked `/cmd` into the box (the
    // partial "co" the user typed survives as trailing args), and sends nothing.
    expect(ta.value.startsWith(`/${expected}`)).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0) // popover dismissed
  })

  it("Tab selects the highlighted row (like Enter) and inserts `/cmd ` without sending", async () => {
    const { ta, onSend } = renderComposer()
    await typeValue(ta, "/co")
    await waitFor(() => expect(rows().length).toBeGreaterThan(1))

    // ↓ moves the highlight; Tab confirms the highlighted row (not the first).
    fireEvent.keyDown(ta, { key: "ArrowDown" })
    expect(highlightedIndex()).toBe(1)
    const expected = nameOf(rowTexts()[1])

    fireEvent.keyDown(ta, { key: "Tab" })
    await new Promise((r) => setTimeout(r, 30))

    expect(ta.value.startsWith(`/${expected}`)).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0) // popover dismissed
  })

  it("ArrowUp from the first row wraps the highlight to the last row", async () => {
    const { ta } = renderComposer()
    await typeValue(ta, "/co")
    await waitFor(() => expect(rows().length).toBeGreaterThan(1))
    const lastIndex = rows().length - 1

    fireEvent.keyDown(ta, { key: "ArrowUp" })
    expect(highlightedIndex()).toBe(lastIndex)
  })

  it("Enter confirms the match by default and inserts `/cmd ` without sending", async () => {
    const { ta, onSend } = renderComposer()
    // Typing the full name → the confirm strips the name, leaving clean `/compact `.
    await typeValue(ta, "/compact")
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 30))

    // `/compact` is dropped in, trailing-space-terminated so the user can keep
    // typing args before sending. (The insert is space-padded on both the pick
    // and the splice sides, so don't couple to the exact space count.)
    expect(ta.value.trimEnd()).toBe("/compact")
    expect(ta.value.endsWith(" ")).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
  })

  it("Escape dismisses the popover and sends nothing", async () => {
    const { ta, onSend } = renderComposer()
    await typeValue(ta, "/compac")
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(ta, { key: "Escape" })
    await new Promise((r) => setTimeout(r, 0))

    expect(rows()).toHaveLength(0)
    expect(onSend).not.toHaveBeenCalled()
    // The text the user typed is left intact — only the popover closed.
    expect(ta.value).toBe("/compac")
  })

  it("backspacing over the leading `/` dismisses the popover", async () => {
    const { ta } = renderComposer()
    await typeValue(ta, "/co")
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))

    // Delete the trigger char entirely → detectTrigger returns null.
    await typeValue(ta, "co")
    await waitFor(() => expect(rows()).toHaveLength(0))
  })
})
