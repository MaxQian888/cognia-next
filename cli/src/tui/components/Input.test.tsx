import React, { useReducer } from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { Input, routePasteInsert } from "./Input"
import { createPasteParser } from "../input/bracketed-paste"
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
}: {
  onSubmit: (t: string) => void
  disabled?: boolean
  listDir?: ListDir
  mentionProviders?: MentionProviders
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

  it("inserts a newline on Shift+Enter and submits multiline", () => {
    const onSubmit = jest.fn()
    render(<Harness onSubmit={onSubmit} />)
    type("a")
    key("", { return: true, shift: true })
    type("b")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith("a\nb")
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

  it("collapses a large paste and expands it on submit", () => {
    const onSubmit = jest.fn()
    const big = "l1\nl2\nl3\nl4\nl5\nl6"
    const { container } = render(<Harness onSubmit={onSubmit} />)
    key(big)
    expect(container.textContent).toContain("[Pasted 6 lines")
    key("", { return: true })
    expect(onSubmit).toHaveBeenCalledWith(big)
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
    expect(text).toContain("Files")
    expect(text).toContain("Skills")
    expect(text).toContain("Cite sources")
    expect(text).toContain("Agents")
    expect(text).toContain("code-reviewer")
    jest.useRealTimers()
  })

  it("shows a loading affordance while skill/agent candidates load", async () => {
    jest.useFakeTimers()
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("@skill:cit")
    // Before the debounce fires, the popup already shows a loading row.
    expect(container.textContent).toContain("loading…")
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

  it("shows an inline hint after a known command + space", () => {
    const onSubmit = jest.fn()
    const { container } = render(<Harness onSubmit={onSubmit} />)
    type("/copy ")
    expect(container.textContent).toContain("/copy [n]")
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

  it("routes a bracketed-paste span (parser → routePasteInsert) to a placeholder", () => {
    const parser = createPasteParser()
    const body = "y".repeat(1000)
    const { pastes } = parser.feed(`\x1b[200~${body}\x1b[201~`)
    expect(pastes).toEqual([body])
    expect(routePasteInsert(pastes[0], 0).isLarge).toBe(true)
  })
})
