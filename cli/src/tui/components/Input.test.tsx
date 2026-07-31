import React, { useReducer } from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

jest.mock("../mention/highlight", () => {
  const actual = jest.requireActual("../mention/highlight")
  return { ...actual, highlightMentions: jest.fn(actual.highlightMentions) }
})

import { Input, routePasteInsert } from "./Input"
import { createInitialState } from "../state/initial"
import { tuiReducer } from "../state/reducer"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"
import { completeAtPath, type DirEntry, type ListDir } from "../commands/file-completer"
import type { MentionCandidate } from "../mention/types"
import type { MentionProviders } from "../mention/providers"
import { MENTION_DEBOUNCE_MS } from "../mention/async-load"

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
}) {
  const [state, dispatch] = useReducer(tuiReducer, undefined, () => createInitialState(config, "s"))
  const ld = listDirProp ?? listDir
  return (
    <Input
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
  beforeEach(() => __resetInk())

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
    const modeIdx = text.indexOf("/mode —")
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
function GhostHarness({ history }: { history: string[] }) {
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
    />
  )
}

describe("Input ghost-text autosuggest", () => {
  beforeEach(() => __resetInk())

  it("shows the dim completion of a prior history entry", () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("deploy ")
    // The buffer shows what was typed plus the ghost remainder.
    expect(container.textContent).toContain("deploy ")
    expect(container.textContent).toContain("to staging")
  })

  it("accepts the suggestion with → at the end of the draft", () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("deploy ")
    key("", { rightArrow: true })
    expect(container.textContent).toContain("deploy to staging")
  })

  it("shows no ghost when nothing matches", () => {
    const { container } = render(<GhostHarness history={["deploy to staging"]} />)
    type("xyz")
    expect(container.textContent).not.toContain("staging")
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
