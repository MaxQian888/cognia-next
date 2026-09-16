import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openBrowser } from "../../mcp/open-browser"
import { TuiInputProvider, useGlobalInput } from "../input/input-router"
import * as elementPosition from "../input/element-position"
import { RenderPrefsProvider } from "../render/context"
import { RENDER_DEFAULTS } from "../../config/schema"
import React, { useReducer } from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

jest.mock("../../mcp/open-browser", () => ({ openBrowser: jest.fn(async () => true) }))

jest.mock("../input/element-position", () => {
  const actual = jest.requireActual("../input/element-position")
  return { ...actual, absoluteTopLeft: jest.fn(actual.absoluteTopLeft) }
})

jest.mock("../mention/highlight", () => {
  const actual = jest.requireActual("../mention/highlight")
  return { ...actual, highlightMentions: jest.fn(actual.highlightMentions) }
})

import { getCommand, registerCommand } from "../commands/registry"
import { SKILL_COMMANDS } from "../commands/skill-commands"
import { CliI18nProvider } from "../i18n"
import { Input, routePasteInsert } from "./Input"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { completeAtPath, type DirEntry, type ListDir } from "../commands/file-completer"
import type { MentionCandidate } from "../mention/types"
import type { MentionProviders } from "../mention/providers"
import { MENTION_DEBOUNCE_MS } from "../mention/async-load"
import type { InlineCompleteFn } from "@/lib/chat/completion/inline/ai-provider"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const listing: Record<string, DirEntry[]> = {
  ".": [
    { name: "src", isDir: true },
    { name: "readme.md", isDir: false },
  ],
}
const listDir: ListDir = (dir) => listing[dir] ?? []

// A stub mention provider so the composer never touches real disk/db in tests.
// Files delegate to the injected `completeAtPath`-shaped lister; skills/agents
// are fixed fixtures filtered by query.
const STUB_SKILLS: MentionCandidate[] = [
  {
    kind: "skill",
    id: "skill_cite",
    label: "Cite sources",
    hint: "cite",
    origin: "claude",
    insert: "@skill:skill_cite",
  },
]
const STUB_AGENTS: MentionCandidate[] = [
  {
    kind: "agent",
    id: "code-reviewer",
    label: "code-reviewer",
    hint: "reviews",
    origin: "agent",
    insert: "@agent:code-reviewer",
  },
]
function stubProviders(ld: ListDir): MentionProviders {
  const sub = (q: string, list: MentionCandidate[]) =>
    list.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()) || c.id.includes(q))
  return {
    // Reuse the real file completer so the legacy `@path` tests stay honest.
    files: (query) =>
      completeAtPath(`@${query}`, ld).map((p) => ({
        kind: "file" as const,
        id: p,
        label: p,
        insert: p,
      })),
    skills: async (q) => sub(q, STUB_SKILLS),
    agents: async (q) => sub(q, STUB_AGENTS),
  }
}

function Harness({
  onSubmit,
  disabled,
  listDir: listDirProp,
  mentionProviders,
  mode,
  placeholder,
  enabledSkillIds,
  onToggleSkill,
  onPopupOpenChange,
  vimEnabled,
  width,
  keybindings,
  clipboardImageReady,
}: {
  onSubmit: (t: string) => void
  disabled?: boolean
  listDir?: ListDir
  mentionProviders?: MentionProviders
  mode?: string
  placeholder?: string
  enabledSkillIds?: Set<string>
  onToggleSkill?: (id: string, enabled: boolean) => void
  onPopupOpenChange?: (open: boolean) => void
  vimEnabled?: boolean
  width?: number
  keybindings?: Record<string, string>
  clipboardImageReady?: boolean
}) {
  const [state, dispatch] = useReducer(tuiReducer, undefined, () => createInitialState(config, "s"))
  const ld = listDirProp ?? listDir
  return (
    <Input
      width={width}
      input={state.input}
      dispatch={dispatch}
      onSubmit={onSubmit}
      disabled={disabled}
      cwd="/work"
      listDir={ld}
      mentionProviders={mentionProviders ?? stubProviders(ld)}
      mode={mode}
      placeholder={placeholder}
      enabledSkillIds={enabledSkillIds}
      onToggleSkill={onToggleSkill}
      onPopupOpenChange={onPopupOpenChange}
      vimEnabled={vimEnabled}
      keybindings={keybindings}
      clipboardImageReady={clipboardImageReady}
    />
  )
}

function key(input: string, k?: Record<string, boolean>) {
  act(() => __fireInput(input, k))
}
function type(text: string) {
  for (const ch of text) key(ch)
}

describe("Input (rich composer)", () => {
  beforeEach(() => {
    __resetInk()
    if (!getCommand("skill")) registerCommand(SKILL_COMMANDS[0])
  })

  it("types and submits a line", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("hello")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("accumulates a burst of keystrokes delivered in one render (no re-render between)", () => {
    // Regression: edits used to be computed from the component's closure buffer
    // and dispatched as a precomputed INPUT_SET. When several keystrokes batch
    // into a single render (the norm once Ink reads stdin directly), they all
    // started from the same stale buffer and only the last survived — the "only
    // one letter types" bug. Firing three keys inside ONE act() (no flush between)
    // reproduces the batch; the reducer-applied edits must compose to "abc".
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    act(() => {
      __fireInput("a")
      __fireInput("b")
      __fireInput("c")
    })
    expect(container.textContent).toContain("abc")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("abc")
  })

  it("shows the placeholder when empty and hides it once typing starts", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} />)
    expect(container.textContent).toContain("Ask, run /commands")
    type("x")
    expect(container.textContent).not.toContain("Ask, run /commands")
  })

  it("honors a custom placeholder", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} placeholder="type here…" />)
    expect(container.textContent).toContain("type here…")
  })

  it("renders without error in bypassPermissions mode (loud border)", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} mode="bypassPermissions" />)
    // Still a working composer — the mode only tints the border.
    type("ok")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("ok")
    expect(container.textContent).toContain("›")
  })

  it("inserts a newline on Shift+Enter and submits multiline", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("a")
    key("", { return: true, shift: true })
    type("b")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("a\nb")
  })

  it("does not re-highlight unchanged lines on cursor-only edits", () => {
    // Rows without the cursor take the `highlightMentions` branch, which this
    // spy sees. The cursor's own row goes through `highlightMentionsWithCursor`
    // and is expected to recompute, so this asserts about the OTHER rows only.
    const highlight = jest.requireMock("../mention/highlight") as {
      highlightMentions: jest.Mock
    }
    render(<Harness onSubmit={jest.fn()} />)
    type("a")
    key("", { return: true, shift: true })
    type("b")
    highlight.highlightMentions.mockClear()
    key("", { leftArrow: true })
    expect(highlight.highlightMentions).not.toHaveBeenCalled()
  })

  it("keeps a mention token coloured on the row the cursor is on", () => {
    // The cursor row used to render as plain text, so an `@agent:` token
    // changed colour as the cursor moved onto and off its line.
    const { container } = render(<Harness onSubmit={jest.fn()} />)
    type("@agent:reviewer go")
    const coloured = Array.from(container.querySelectorAll("[data-color]")).filter((el) =>
      (el.textContent ?? "").includes("@agent:reviewer")
    )
    expect(coloured.length).toBeGreaterThan(0)
  })

  it("backspaces characters", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("ax")
    key("", { backspace: true })
    type("b")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("ab")
  })

  it("handles word delete and line kill chords", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("alpha beta gamma")
    key("w", { ctrl: true })
    key("u", { ctrl: true })
    type("prefix suffix")
    key("a", { ctrl: true })
    key("k", { ctrl: true })
    type("done")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("done")
  })

  it("undoes and redoes text edits (Ctrl+Z / Ctrl+Y)", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("ab")
    key("z", { ctrl: true }) // undo "b"
    key("z", { ctrl: true }) // undo "a"
    key("", { return: true })
    expect(onSubmit).not.toHaveBeenCalled() // empty buffer never submits
    key("y", { ctrl: true }) // redo "a"
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("a")
  })

  it("shows the slash palette and accepts a command", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/mo")
    expect(container.textContent).toContain("/model")
    expect(container.textContent).toContain("/mode")
    key("", { downArrow: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("/mode")
  })

  it("dismisses the slash palette on Escape", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/mo")
    expect(container.textContent).toContain("/model")
    key("", { escape: true })
    expect(container.textContent).not.toContain("— switch the model")
  })

  it("completes an @ file path", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@s")
    expect(container.textContent).toContain("@src/")
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@src/")
  })

  it("completes a file-path argument in bash (!) mode", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("!cat re")
    // Bare path candidate (no @ sigil) for the trailing argument.
    expect(container.textContent).toContain("readme.md")
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("!cat readme.md")
  })

  it("does not offer bash path completion for the command name itself", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} />)
    type("!sr")
    // "sr" is the command name (no preceding space) — no path popup.
    expect(container.textContent).not.toContain("src/")
  })

  it("drills into a folder: accepting a dir keeps the popup open for its contents", () => {
    const onSubmit = jest.fn()
    const nested: Record<string, DirEntry[]> = {
      ".": [{ name: "src", isDir: true }],
      src: [
        { name: "App.tsx", isDir: false },
        { name: "tui", isDir: true },
      ],
    }
    const { container } = render(
      <Harness onSubmit={onSubmit} listDir={(dir) => nested[dir] ?? []} />
    )
    type("@s")
    expect(container.textContent).toContain("@src/")
    // Accept the directory — no trailing space, popup re-derives for `src/`.
    key("", { tab: true })
    expect(container.textContent).toContain("@src/App.tsx")
    expect(container.textContent).toContain("@src/tui/")
    // Contents sort dirs-first (tui/ at 0, App.tsx at 1); step down to the file,
    // accept it — terminal, so a trailing space closes the popup — then submit.
    key("", { downArrow: true })
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@src/App.tsx")
  })

  it("recalls history with the up arrow", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("first")
    key("", { return: true })
    key("", { upArrow: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenNthCalledWith(2, "first")
  })

  it("swallows a mouse click instead of inserting the raw escape", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("hello")
    // A left-click SGR report must never land in the buffer as literal text
    // (cursor repositioning needs a real Yoga layout, absent under the mock).
    key("[<0;6;2M")
    expect(container.textContent ?? "").not.toContain("[<0")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("shows the shell-mode hint while a `!` command is being typed", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} />)
    type("!ls -la")
    expect(container.textContent).toContain("shell mode")
  })

  it("keeps cycling history past a bare slash-command entry instead of freezing", () => {
    // Repro for the focus-freeze bug: a recalled `/cmd` history line used to
    // re-open the slash palette, which then captured ↑/↓ and stranded the user
    // mid-cycle. The fix suppresses the palette for recalled entries, so the
    // user can step right past the slash entry to the oldest plain one.
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("alpha")
    key("", { return: true })
    // Submit a slash command via the palette so a bare `/cmd` lands in history.
    type("/help")
    key("", { return: true })
    type("gamma")
    key("", { return: true })
    // Walk back up: gamma → <slash> → alpha. The middle (slash) entry must not
    // trap navigation — the palette stays closed while browsing history.
    key("", { upArrow: true }) // gamma
    key("", { upArrow: true }) // the slash entry
    key("", { upArrow: true }) // alpha (only reachable if the popup didn't steal ↑)
    key("", { return: true })
    expect(onSubmit).toHaveBeenLastCalledWith("alpha")
  })

  it("collapses a large paste and expands it on submit", () => {
    const onSubmit = jest.fn()
    const big = "l1\nl2\nl3\nl4\nl5\nl6"
    const { container } = render(<Harness onSubmit={onSubmit} />)
    // Ink ≥7 coalesces a bracketed paste into a single `useInput` call, so the
    // whole paste arrives as one `key(big)` insert (not char-by-char).
    key(big)
    expect(container.textContent).toContain("[Pasted 6 lines")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith(big)
  })

  it("never attaches a stdin 'data' listener (would starve Ink's paused reads)", () => {
    // Regression guard: Ink ≥7 reads stdin in PAUSED mode via the 'readable'
    // event + `stdin.read()`. A stray `stdin.on('data')` listener flips the
    // stream into flowing mode, so `read()` returns null and ALL keyboard input
    // dies — the composer appears to lose focus. The component must rely on
    // Ink's own paste coalescing instead of teeing raw stdin.
    const before = process.stdin.listenerCount("data")
    const { unmount } = render(<Harness onSubmit={jest.fn()} />)
    expect(process.stdin.listenerCount("data")).toBe(before)
    unmount()
    expect(process.stdin.listenerCount("data")).toBe(before)
  })

  it("boosts recently used slash commands to the top of the palette", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/model")
    key("", { return: true })
    // Open the palette again and explicitly select /mode (not /model) so the
    // second submission is recorded as a distinct, more recent command.
    type("/mo")
    key("", { downArrow: true })
    key("", { return: true })
    type("/")
    // The palette lists all commands; /mode was used most recently, so it sorts
    // before /model even though /model is registered first.
    const text = container.textContent ?? ""
    const modeIdx = text.indexOf("/mode ")
    const modelIdx = text.indexOf("/model —")
    expect(modeIdx).toBeGreaterThan(-1)
    expect(modelIdx).toBeGreaterThan(-1)
    expect(modeIdx).toBeLessThan(modelIdx)
  })

  it("does not handle keys when disabled", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} disabled />)
    type("hi")
    key("", { return: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("shows a mixed @ popup with files, skills, and agents", async () => {
    jest.useFakeTimers()
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@")
    // Files render synchronously; skills/agents arrive after the debounced load.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    const text = container.textContent ?? ""
    // Rows self-identify by a per-kind glyph (no separate group-header lines, so
    // the popup height stays constant while navigating). The labels still show.
    expect(text).toContain("readme.md")
    expect(text).toContain("Cite sources")
    expect(text).toContain("code-reviewer")
    jest.useRealTimers()
  })

  it("does not relist file mentions when only async mention state changes", async () => {
    jest.useFakeTimers()
    const countedListDir = jest.fn(listDir)
    render(<Harness onSubmit={jest.fn()} listDir={countedListDir} />)
    type("@")
    const callsAfterTyping = countedListDir.mock.calls.length
    expect(callsAfterTyping).toBeGreaterThan(0)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    expect(countedListDir).toHaveBeenCalledTimes(callsAfterTyping)
    jest.useRealTimers()
  })

  it("shows a loading affordance while skill/agent candidates load", async () => {
    jest.useFakeTimers()
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@skill:cit")
    // Before the debounce fires, the popup already shows a mode-aware loading row.
    expect(container.textContent).toContain("loading skills…")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    expect(container.textContent).toContain("Cite sources")
    jest.useRealTimers()
  })

  it("accepts a @skill: mention and inserts the token", async () => {
    jest.useFakeTimers()
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@skill:cit")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    expect(container.textContent).toContain("Cite sources")
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@skill:skill_cite")
    jest.useRealTimers()
  })

  it("accepts a @agent: mention and inserts the token", async () => {
    jest.useFakeTimers()
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@agent:code")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    expect(container.textContent).toContain("code-reviewer")
    key("", { tab: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@agent:code-reviewer")
    jest.useRealTimers()
  })

  it("annotates an enabled skill row with a filled badge", async () => {
    jest.useFakeTimers()
    const onSubmit = jest.fn()
    const { container } = render(
      <Harness onSubmit={onSubmit} enabledSkillIds={new Set(["skill_cite"])} />
    )
    type("@skill:cit")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    expect(container.textContent).toContain("●")
    jest.useRealTimers()
  })

  it("Shift+Tab toggles the highlighted skill from the popup", async () => {
    jest.useFakeTimers()
    const onToggleSkill = jest.fn()
    render(<Harness onSubmit={jest.fn()} onToggleSkill={onToggleSkill} />)
    type("@skill:cit")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    key("", { tab: true, shift: true })
    expect(onToggleSkill).toHaveBeenCalledWith("skill_cite", true)
    jest.useRealTimers()
  })

  it("the mouse wheel scrolls the open popup without inserting characters", async () => {
    jest.useFakeTimers()
    const { container } = render(<Harness onSubmit={jest.fn()} />)
    type("@")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    const before = container.textContent ?? ""
    // SGR wheel-down report (button 65). Must not land in the buffer as literal text.
    key("[<65;5;5M")
    expect(container.textContent).not.toContain("[<65")
    expect((container.textContent ?? "").length).toBeGreaterThanOrEqual(before.length - 80)
    jest.useRealTimers()
  })

  it("reports popup open/close transitions to the parent", async () => {
    jest.useFakeTimers()
    const onPopupOpenChange = jest.fn()
    render(<Harness onSubmit={jest.fn()} onPopupOpenChange={onPopupOpenChange} />)
    type("@")
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    })
    expect(onPopupOpenChange).toHaveBeenCalledWith(true)
    jest.useRealTimers()
  })

  it("shows an inline hint after a known command + space", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/copy ")
    expect(container.textContent).toContain("/copy [n|code|tool|user]")
  })

  it("opens subcommands before running and completes a filtered action", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/skil")
    key("", { return: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.textContent).toContain("enable")
    type("en")
    key("", { tab: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.textContent).toContain("/skill enable")
    type("my-skill")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("/skill enable my-skill")
  })

  it("runs a selected subcommand and Escape returns to the root level", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/skill ")
    key("", { escape: true })
    expect(onSubmit).not.toHaveBeenCalled()
    key("", { return: true })
    expect(container.textContent).toContain("panel")
    key("", { downArrow: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("/skill list")
  })

  it("Enter on a subcommand with arguments submits to the parameter form dispatcher", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("/skill create")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("/skill create")
  })

  it("Tab completes a slash command in place without submitting", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    // `config` is an alias of `settings`; Tab resolves to the canonical name.
    type("/conf")
    key("", { tab: true })
    expect(onSubmit).not.toHaveBeenCalled()
    // The buffer now holds the completed command ready for args.
    expect(container.textContent).toContain("/settings")
  })
})

// Seeds composer history so ghost-text autosuggest has something to complete.
function GhostHarness({
  history,
  aiComplete,
  agentComplete,
}: {
  history: string[]
  aiComplete?: InlineCompleteFn | null
  agentComplete?: InlineCompleteFn | null
}) {
  const [state, dispatch] = useReducer(tuiReducer, undefined, () => createInitialState(config, "s"))
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    for (const h of history) dispatch({ type: "INPUT_PUSH_HISTORY", entry: h })
  }, [history])
  return (
    <Input
      input={state.input}
      dispatch={dispatch}
      onSubmit={jest.fn()}
      cwd="/work"
      listDir={listDir}
      mentionProviders={stubProviders(listDir)}
      aiComplete={aiComplete ?? null}
      agentComplete={agentComplete ?? null}
      suggestDebounceMs={200}
    />
  )
}

/**
 * Let the completion providers settle. Suggestions now come from the shared
 * engine (`lib/chat/completion/inline/`), which resolves even its "sync"
 * providers through a promise — so the ghost lands a microtask after the
 * keystroke rather than during the same render pass.
 */
async function settleGhost(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

describe("Input ghost-text autosuggest", () => {
  beforeEach(() => __resetInk())

  it("shows the dim completion of a prior history entry", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("deploy ")
    await settleGhost()
    // The buffer shows what was typed plus the ghost remainder.
    expect(container.textContent).toContain("deploy ")
    expect(container.textContent).toContain("to staging")
  })

  it("labels the ghost with the source it came from", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("deploy ")
    await settleGhost()
    expect(container.textContent).toContain("history")
  })

  it("accepts the suggestion with → at the end of the draft", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("deploy ")
    await settleGhost()
    key("", { rightArrow: true })
    expect(container.textContent).toContain("deploy to staging")
  })

  it("shows no ghost when nothing matches", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("xyz")
    await settleGhost()
    expect(container.textContent).not.toContain("staging")
  })

  it("ranks the most recent of several matching entries first", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging", "deploy to prod"]} />)
    type("deploy to ")
    await settleGhost()
    expect(container.textContent).toContain("prod")
  })

  it("cycles to the next candidate with alt+]", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging", "deploy to prod"]} />)
    type("deploy to ")
    await settleGhost()
    key("]", { meta: true })
    expect(container.textContent).toContain("staging")
  })

  it("surfaces a model continuation once the debounce elapses", async () => {
    const { container } = render(
      <GhostHarness history={[]} aiComplete={async () => "the release notes"} />
    )
    type("write ")
    await settleGhost(300)
    expect(container.textContent).toContain("the release notes")
    expect(container.textContent).toContain("AI")
  })

  it("falls back to history when the model call fails", async () => {
    const { container } = render(
      <GhostHarness
        history={["write the changelog"]}
        aiComplete={async () => {
          throw new Error("no provider")
        }}
      />
    )
    type("write ")
    await settleGhost(300)
    expect(container.textContent).toContain("the changelog")
  })
})

describe("routePasteInsert (paste routing)", () => {
  it("collapses a multi-line paste above the line threshold", () => {
    const r = routePasteInsert("a\nb\nc\nd\ne", 0)
    expect(r.isLarge).toBe(true)
    expect(r.display).toBe("[Pasted 5 lines #0]")
  })

  it("collapses a single very long line via the char threshold", () => {
    const r = routePasteInsert("x".repeat(1000), 3)
    expect(r.isLarge).toBe(true)
    expect(r.lineCount).toBe(1)
    expect(r.display).toBe("[Pasted 1 lines #3]")
  })

  it("leaves a small paste inline", () => {
    const r = routePasteInsert("hi there", 1)
    expect(r.isLarge).toBe(false)
    expect(r.display).toBe("hi there")
  })

  it("collapses a coalesced paste (one useInput chunk) to a placeholder", () => {
    // Ink ≥7 parses the bracketed-paste span natively and forwards the whole
    // body to `useInput` as a SINGLE insert — simulated here by firing one large
    // chunk. The composer must collapse it to a `[Pasted …]` placeholder rather
    // than dumping the raw body into the buffer.
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    const body = "y".repeat(1000)
    key(body)
    expect(container.textContent).toContain("[Pasted")
    expect(container.textContent).not.toContain(body)
  })
})

describe("Input vim mode (/vim)", () => {
  beforeEach(() => __resetInk())

  it("Esc drops to NORMAL (indicator shown) and printable keys stop inserting", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} vimEnabled />)
    type("hello")
    key("", { escape: true })
    expect(container.textContent).toContain("-- NORMAL --")
    // `z` is not a vim motion — swallowed, never inserted.
    type("z")
    expect(container.textContent).not.toContain("helloz")
  })

  it("NORMAL-mode edits work end to end (0, dw)", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} vimEnabled />)
    type("one two")
    key("", { escape: true })
    type("0dw")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("two")
  })

  it("i returns to INSERT so typing works again", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} vimEnabled />)
    type("abc")
    key("", { escape: true })
    type("i")
    expect(container.textContent).not.toContain("-- NORMAL --")
    type("x")
    key("", { return: true })
    // INSERT re-entered before the last char ("c") — cursor sat on it after Esc.
    expect(onSubmit).toHaveBeenCalledWith("abxc")
  })

  it("Enter submits from NORMAL mode and resets to INSERT", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} vimEnabled />)
    type("ship it")
    key("", { escape: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("ship it")
    expect(container.textContent).not.toContain("-- NORMAL --")
  })

  it("without /vim, Esc keeps its default behaviour (no NORMAL mode)", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("hello")
    key("", { escape: true })
    expect(container.textContent).not.toContain("-- NORMAL --")
    type("z")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("helloz")
  })
})

it("omits the decorative caret for screen readers while preserving editable text", async () => {
  __resetInk()
  const { container } = render(
    <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
      <Harness onSubmit={() => {}} />
    </RenderPrefsProvider>
  )
  expect(container.textContent).not.toContain("█")
  await act(async () => {
    type("hello")
    await Promise.resolve()
  })
  expect(container.textContent).toContain("hello")
  expect(container.textContent).not.toContain("█")
})

describe("Input mouse selection and manual completion", () => {
  beforeEach(() => __resetInk())
  afterEach(() => {
    jest
      .mocked(elementPosition.absoluteTopLeft)
      .mockReset()
      .mockImplementation(jest.requireActual("../input/element-position").absoluteTopLeft)
  })

  it("accepts a slash command by clicking its visible popup row", () => {
    jest.mocked(elementPosition.absoluteTopLeft).mockReturnValue({ top: 0, left: 0 })
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("/help")
    key("[<0;4;2M")
    expect(onSubmit).toHaveBeenCalledWith("/help")
  })

  it("accepts a file mention by clicking below the popup header", async () => {
    jest.mocked(elementPosition.absoluteTopLeft).mockReturnValue({ top: 0, left: 0 })
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("@read")
    await settleGhost()
    key("[<0;4;3M")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("@readme.md")
  })

  it("positions the cursor using terminal columns and ignores clicks outside the editor", () => {
    jest.mocked(elementPosition.absoluteTopLeft).mockReturnValue({ top: 0, left: 0 })
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("你好")
    key("[<0;5;1M")
    type("X")
    key("[<0;6;99M")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("你X好")
  })

  it("does not submit when clicking a slash popup border", () => {
    jest.mocked(elementPosition.absoluteTopLeft).mockReturnValue({ top: 0, left: 0 })
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("/help")
    key("[<0;4;1M")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("runs manual agent completion only on demand and accepts its result with Tab", async () => {
    let resolveCompletion!: (value: string) => void
    const completion = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCompletion = resolve
        })
    )
    const { container } = render(<GhostHarness history={[]} agentComplete={completion} />)
    type("write ")
    await settleGhost()
    expect(container.textContent).toContain("agent")
    expect(completion).not.toHaveBeenCalled()
    key("\\", { meta: true })
    await settleGhost()
    expect(completion).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("asking the agent")
    await act(async () => {
      resolveCompletion("the release notes")
      await Promise.resolve()
    })
    await settleGhost()
    key("", { tab: true })
    expect(container.textContent).toContain("write the release notes")
  })

  it("cycles backward through history completions", async () => {
    const { container } = render(<GhostHarness history={["deploy to staging", "deploy to prod"]} />)
    type("deploy to ")
    await settleGhost()
    key("[", { meta: true })
    expect(container.textContent).toContain("staging")
  })

  it("routes Vim undo and redo to the composer history", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} vimEnabled />)
    type("abc")
    key("", { escape: true })
    key("x")
    key("u")
    key("r", { ctrl: true })
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("ab")
  })
})

describe("image attachments in the composer", () => {
  let dir: string
  let image: string
  let prevForceHyperlink: string | undefined
  beforeEach(() => {
    __resetInk()
    jest.mocked(openBrowser).mockClear()
    // These tests assert on the composed TEXT ("before[Image 1]", "the real
    // path is hidden"). On hyperlink-capable terminals the label is wrapped in
    // an OSC-8 escape whose target embeds the file path — decoration these
    // assertions are not about. Force hyperlinks off so the suite does not
    // depend on the developer's terminal env (Ghostty/kitty/iTerm/…).
    prevForceHyperlink = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = "0"
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-images-"))
    image = path.join(dir, "屏幕 shot.png")
    fs.writeFileSync(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
        "base64"
      )
    )
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    if (prevForceHyperlink === undefined) delete process.env.FORCE_HYPERLINK
    else process.env.FORCE_HYPERLINK = prevForceHyperlink
  })

  it("pastes at the cursor, numbers multiple images and sends their actual paths", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("beforeafter")
    for (let i = 0; i < 5; i++) key("", { leftArrow: true })
    key(image.replace(/ /g, "\\ "))
    expect(container.textContent).toContain("before[Image 1]")
    expect(container.textContent).toContain("after")
    expect(container.textContent).not.toContain(dir)
    key(`"${image}"`)
    expect(container.textContent).toContain("[Image 2]")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith(`before@"${image}"@"${image}"after`)
  })

  it("removes an image atomically, restores it with undo, and recalls a sendable attachment", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    key(`"${image}"`)
    key("", { backspace: true })
    expect(container.textContent).not.toContain("[Image")
    key("z", { ctrl: true })
    expect(container.textContent).toContain("[Image 1]")
    key("", { return: true })
    key("", { upArrow: true })
    expect(container.textContent).toContain("[Image 1]")
    expect(container.textContent).not.toContain(dir)
    key("", { return: true })
    expect(onSubmit.mock.calls.map(([text]) => text)).toEqual([`@"${image}"`, `@"${image}"`])
  })

  it("does not open an attachment when the click hits the preceding wide character", () => {
    jest.mocked(elementPosition.absoluteTopLeft).mockReturnValue({ top: 0, left: 0 })
    render(<Harness onSubmit={jest.fn()} />)
    type("中")
    key(`"${image}"`)
    key("[<0;4;1M")
    expect(openBrowser).not.toHaveBeenCalled()
    key("[<0;5;1M")
    expect(openBrowser).toHaveBeenCalledTimes(1)
  })

  it("opens a wrapped image label at its actual terminal coordinates before the global mouse handler", () => {
    const global = jest.fn()
    function Global() {
      useGlobalInput(global, { shouldHandle: (text) => text.startsWith("[<") })
      return null
    }
    jest.mocked(elementPosition.absoluteTopLeft).mockReturnValue({ top: 10, left: 4 })
    render(
      <TuiInputProvider>
        <Global />
        <Harness onSubmit={jest.fn()} width={20} />
      </TuiInputProvider>
    )
    type("你好abcdefgh")
    key(`"${image}"`)
    // 14 text columns: the first two label cells wrap after the 12-cell prefix.
    key("[<0;8;12M")
    expect(openBrowser).toHaveBeenCalledTimes(1)
    expect(jest.mocked(openBrowser).mock.calls[0][0]).toContain(encodeURIComponent("屏幕 shot.png"))
    expect(global).not.toHaveBeenCalledWith("[<0;8;12M", expect.anything())
    key("[<0;8;30M")
    expect(openBrowser).toHaveBeenCalledTimes(1)
  })

  it("advertises the configured paste chord while the clipboard holds an image", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} clipboardImageReady />)
    expect(container.textContent).toContain("image in clipboard · Ctrl+V to paste")
  })

  it("renders a rebound paste chord in the hint", () => {
    const { container } = render(
      <Harness onSubmit={jest.fn()} clipboardImageReady keybindings={{ pasteImage: "ctrl+g" }} />
    )
    expect(container.textContent).toContain("Ctrl+G to paste")
  })

  it("counts pasted images and points at /images for management", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} />)
    key(`"${image}"`)
    expect(container.textContent).toContain("1 attached · /images to manage")
    key(`"${image}"`)
    expect(container.textContent).toContain("2 attached · /images to manage")
  })

  it("joins the clipboard hint with the attachment count", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} clipboardImageReady />)
    key(`"${image}"`)
    const text = container.textContent ?? ""
    expect(text).toContain("image in clipboard · Ctrl+V to paste")
    expect(text).toContain("1 attached · /images to manage")
  })

  it("hides both hints while the composer is disabled", () => {
    const { container } = render(<Harness onSubmit={jest.fn()} disabled clipboardImageReady />)
    expect(container.textContent ?? "").not.toContain("image in clipboard")
    expect(container.textContent ?? "").not.toContain("to manage")
  })
})

it("updates the default composer placeholder when the locale changes", () => {
  const onSubmit = jest.fn()
  const view = render(
    <CliI18nProvider locale="en">
      <Harness onSubmit={onSubmit} />
    </CliI18nProvider>
  )
  expect(view.container.textContent).toContain("Ask, run /commands")
  view.rerender(
    <CliI18nProvider locale="zh-CN">
      <Harness onSubmit={onSubmit} />
    </CliI18nProvider>
  )
  expect(view.container.textContent).toContain("输入问题")
  expect(view.container.textContent).not.toContain("Ask, run")
  view.rerender(
    <CliI18nProvider locale="zh-CN">
      <Harness onSubmit={onSubmit} placeholder="custom hint" />
    </CliI18nProvider>
  )
  expect(view.container.textContent).toContain("custom hint")
})
