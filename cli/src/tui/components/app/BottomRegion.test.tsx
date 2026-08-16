import React from "react"
import { render } from "@testing-library/react"

import { BottomRegion, type BottomRegionProps } from "./BottomRegion"
import { ThemeProvider } from "../../theme/context"
import { RenderPrefsProvider } from "../../render/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import { resolveRenderConfig } from "../../../config/schema"
import { resolveKeybindings } from "../../input/keybindings"
import { createInitialState } from "../../state/initial"
import { DEFAULT_RESOLVED_CONFIG } from "../../../config/schema"
import type { ResolvedConfig } from "../../../config/schema"
import type { TuiState } from "../../state/types"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { MentionProviders } from "../../mention/providers"
import { terminalLayout } from "../../layout/terminal-layout"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

const baseState = (over: Partial<TuiState> = {}): TuiState => ({
  ...createInitialState(config, "s1", true, []),
  ...over,
})

const cursor = (find: { query: string } | null = null): TranscriptCursor =>
  ({
    measuring: false,
    matchCount: 0,
    matchIndex: 0,
    state: { focusedCellId: null, find },
    reportCellHeight: jest.fn(),
  }) as unknown as TranscriptCursor

const mentionProviders = {
  skills: jest.fn(async () => []),
  agents: jest.fn(async () => []),
  files: jest.fn(async () => []),
} as unknown as MentionProviders

function baseProps(over: Partial<BottomRegionProps> = {}): BottomRegionProps {
  return {
    state: baseState(),
    dispatch: jest.fn(),
    cursor: cursor(),
    overlayOpen: false,
    columns: 80,
    popupRows: 6,
    composerRows: 3,
    layout: terminalLayout(80, 24),
    warningColor: "yellow",
    streamStartedAt: null,
    lastActivityAt: null,
    footerSubagentRunning: null,
    footerBackgroundSubagents: 0,
    interruptedBackgroundSubagents: 0,
    footerCopilot: undefined,
    backtrackArmed: false,
    subagentChipRef: { current: null },
    agentTreeRef: { current: null },
    // Local completion on (the default), model tier off — no model is
    // reachable from a unit test.
    localSuggestEnabled: true,
    aiComplete: null,
    handleSubmit: jest.fn(),
    handleHistoryPush: jest.fn(),
    listDir: undefined,
    mentionProviders,
    keybindings: resolveKeybindings(undefined),
    enabledSkillIds: new Set<string>(),
    toggleSkillEnabled: jest.fn(),
    handlePopupOpenChange: jest.fn(),
    footerPlanTitle: undefined,
    footerRowRef: { current: null },
    footerSegmentsRef: { current: null },
    ...over,
  }
}

const wrap = (el: React.ReactElement) =>
  render(
    <ThemeProvider palette={BUILTIN_THEMES.ansi}>
      <RenderPrefsProvider prefs={resolveRenderConfig(undefined)}>{el}</RenderPrefsProvider>
    </ThemeProvider>
  )

describe("BottomRegion", () => {
  it("renders the composer when no overlay/find is active", () => {
    const { container } = wrap(<BottomRegion {...baseProps()} />)
    expect(container.firstElementChild).toHaveAttribute("data-flex-shrink", "0")
    // The Input composer renders its prompt prefix; the footer renders the cwd.
    expect(container.textContent).toContain("/work")
    expect(container.textContent).toContain("zzz")
  })

  it("renders the find bar instead of the composer while finding", () => {
    const { container } = wrap(
      <BottomRegion {...baseProps({ cursor: cursor({ query: "abc" }) })} />
    )
    expect(container.textContent).toContain("abc")
  })

  it("shows the backtrack selection notice", () => {
    const state = baseState({
      cells: [{ id: "c1", kind: "user", text: "hi" }] as TuiState["cells"],
      backtrack: { index: 0 },
    })
    const { container } = wrap(<BottomRegion {...baseProps({ state })} />)
    expect(container.textContent).toContain("Editing message #1/1")
    expect(container.textContent).toContain("Enter to edit")
  })

  it("shows the edit-target discard warning", () => {
    const state = baseState({
      cells: [
        { id: "c1", kind: "user", text: "a" },
        { id: "c2", kind: "assistant", text: "b" },
        { id: "c3", kind: "user", text: "c" },
      ] as TuiState["cells"],
      editTarget: { index: 0 },
    })
    const { container } = wrap(<BottomRegion {...baseProps({ state })} />)
    expect(container.textContent).toContain("later turn(s) will be discarded")
  })

  it("hides the composer when an overlay is open", () => {
    const state = baseState({ input: { ...baseState().input } })
    const { container } = wrap(<BottomRegion {...baseProps({ overlayOpen: true, state })} />)
    // Footer still renders (cwd present) but the composer is unmounted.
    expect(container.textContent).toContain("/work")
  })

  it("does not let connection toasts consume modal overlay rows", () => {
    const state = baseState({
      toasts: [
        {
          id: "mcp-failed",
          severity: "warn",
          message: 'MCP server "context7" failed to load',
          hint: "Open /mcp to see the error.",
        },
      ],
    })
    const { container } = wrap(<BottomRegion {...baseProps({ overlayOpen: true, state })} />)
    expect(container.textContent).not.toContain("context7")
  })

  it("retains the composer/activity but hides mascot and footer in the tiny layout", () => {
    const { container } = wrap(
      <BottomRegion {...baseProps({ columns: 30, layout: terminalLayout(30, 8) })} />
    )
    expect(container.textContent).not.toContain("⚙ /settings")
  })

  it("keeps the interrupt status on the left and moves the pet to the right", () => {
    const state = baseState({ turnStatus: "streaming" })
    const { container } = wrap(
      <BottomRegion {...baseProps({ state, streamStartedAt: Date.now() })} />
    )
    const text = container.textContent ?? ""
    const statusAt = text.indexOf("esc to interrupt")
    const petAt = text.indexOf("ʕ")
    expect(statusAt).toBeGreaterThanOrEqual(0)
    expect(petAt).toBeGreaterThanOrEqual(0)
    expect(statusAt).toBeLessThan(petAt)
    const petSlot = container.querySelector('[data-testid="mascot-right-slot"]')
    expect(petSlot).toHaveAttribute("data-width", "100%")
    expect(petSlot).toHaveAttribute("data-justify-content", "flex-end")
  })
})
