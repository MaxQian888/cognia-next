import React from "react"
import { render } from "@testing-library/react"

import { hasSpinnerFrame } from "../Spinner"

import { TranscriptRegion } from "./TranscriptRegion"
import { ThemeProvider } from "../../theme/context"
import { RenderPrefsProvider } from "../../render/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
import { terminalLayout } from "../../layout/terminal-layout"
import { resolveRenderConfig } from "../../../config/schema"
import { createInitialState } from "../../state/initial"
import { DEFAULT_RESOLVED_CONFIG } from "../../../config/schema"
import type { ResolvedConfig } from "../../../config/schema"
import type { TuiState } from "../../state/types"
import type { ScrollController } from "../../hooks/useScroll"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { BackendIdentity } from "../../runtime/backend-identity"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

function makeState(): TuiState {
  const base = createInitialState(config, "s1", true, [])
  return {
    ...base,
    cells: [{ id: "c1", kind: "user", text: "hello world" }] as TuiState["cells"],
  }
}

const scroll = (over: Partial<ScrollController> = {}): ScrollController =>
  ({
    offset: 0,
    atBottom: true,
    hidden: { above: 0, below: 0 },
    measure: jest.fn(),
    reset: jest.fn(),
    toRow: jest.fn(),
    pageUp: jest.fn(),
    pageDown: jest.fn(),
    lineUp: jest.fn(),
    lineDown: jest.fn(),
    ...over,
  }) as unknown as ScrollController

const cursor = (): TranscriptCursor =>
  ({
    measuring: false,
    state: { focusedCellId: null, find: null },
    reportCellHeight: jest.fn(),
  }) as unknown as TranscriptCursor

/** Built-in identity — what `backendIdentity` returns when no external agent
 * is hosting, which is the default these render cases exercise. */
const builtinIdentity: BackendIdentity = {
  provider: "anthropic",
  model: "claude-x",
  external: false,
}

const wrap = (el: React.ReactElement) =>
  render(
    <ThemeProvider palette={BUILTIN_THEMES.ansi}>
      <RenderPrefsProvider prefs={resolveRenderConfig(undefined)}>{el}</RenderPrefsProvider>
    </ThemeProvider>
  )

describe("TranscriptRegion", () => {
  it("renders the transcript with the welcome banner header in scrollback mode", () => {
    const { container } = wrap(
      <TranscriptRegion
        state={makeState()}
        fullscreen={false}
        banner={<>BANNER</>}
        identity={builtinIdentity}
        activeModel="claude-x"
        scroll={scroll()}
        scrollContentRef={{ current: null }}
        cursor={cursor()}
        mutedColor="gray"
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("BANNER")
    expect(text).toContain("hello world")
  })

  it("renders the fullscreen status banner + transcript and hides the scroll hint at bottom", () => {
    const { container } = wrap(
      <TranscriptRegion
        state={makeState()}
        fullscreen
        banner={<>BANNER</>}
        identity={builtinIdentity}
        activeModel="claude-x"
        scroll={scroll({ atBottom: true })}
        scrollContentRef={{ current: null }}
        cursor={cursor()}
        mutedColor="gray"
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("hello world")
    // The fullscreen banner does NOT re-use the scrollback `banner` node.
    expect(text).not.toContain("BANNER")
    expect(text).not.toContain("more line")
  })

  it("shows the scrolled-up hint when not pinned to the bottom", () => {
    const { container } = wrap(
      <TranscriptRegion
        state={makeState()}
        fullscreen
        banner={<>BANNER</>}
        identity={builtinIdentity}
        activeModel="claude-x"
        scroll={scroll({ atBottom: false, hidden: { above: 2, below: 5 } })}
        scrollContentRef={{ current: null }}
        cursor={cursor()}
        mutedColor="gray"
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("5 more lines below")
    expect(text).toContain("End to jump to latest")
  })

  describe("external backend", () => {
    /** State whose config hosts Codex, with no context window ever reported. */
    const externalState = (): TuiState => {
      const base = makeState()
      return {
        ...base,
        config: { ...base.config, agentBackend: "codex" },
        usage: { inputTokens: 1000, outputTokens: 500 },
      } as TuiState
    }

    const externalIdentity: BackendIdentity = {
      provider: "codex (codex-app-server)",
      external: true,
    }

    it("pins the external backend as the identity, not the built-in provider", () => {
      const { container } = wrap(
        <TranscriptRegion
          state={externalState()}
          fullscreen
          banner={<>BANNER</>}
          identity={externalIdentity}
          activeModel="claude-x"
          scroll={scroll({ atBottom: true })}
          scrollContentRef={{ current: null }}
          cursor={cursor()}
          mutedColor="gray"
        />
      )
      const text = container.textContent ?? ""
      expect(text).toContain("codex (codex-app-server)")
      // The built-in provider's model must never appear while Codex answers —
      // it is not what runs, and the fixed header stays on screen all session.
      expect(text).not.toContain("claude-x")
    })

    it("omits the context gauge when the external agent's window is unknown", () => {
      const { container } = wrap(
        <TranscriptRegion
          state={externalState()}
          fullscreen
          banner={<>BANNER</>}
          identity={externalIdentity}
          activeModel="claude-x"
          scroll={scroll({ atBottom: true })}
          scrollContentRef={{ current: null }}
          cursor={cursor()}
          mutedColor="gray"
        />
      )
      // A percentage here could only have come from the built-in catalog window.
      expect(container.textContent ?? "").not.toContain("% ctx")
    })
  })
})

it.each([false, true])(
  "derives approval waiting from the overlay in fullscreen=%s",
  (fullscreen) => {
    const state = makeState()
    state.inflight.tools = [
      {
        id: "t",
        kind: "tool",
        callKey: "t",
        toolName: "bash",
        input: { command: "touch approved.txt" },
        status: "running",
        collapsed: true,
      },
    ]
    state.overlay = {
      kind: "permission",
      req: { toolName: "bash" } as never,
      choices: [],
      index: 0,
    }
    const { container } = wrap(
      <TranscriptRegion
        state={state}
        fullscreen={fullscreen}
        banner={null}
        identity={builtinIdentity}
        activeModel="claude-x"
        scroll={scroll()}
        scrollContentRef={{ current: null }}
        cursor={cursor()}
        mutedColor="gray"
      />
    )
    expect(container.textContent).toContain("Waiting for approval")
    expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
  }
)

describe("permission waiting across transcript layouts", () => {
  function waitingState(): TuiState {
    const state = makeState()
    state.turnStatus = "streaming"
    state.inflight.tools = [
      {
        id: "write",
        kind: "tool",
        callKey: "write",
        toolName: "bash",
        input: { command: "touch approved.txt" },
        status: "running",
        collapsed: true,
      },
    ]
    state.overlay = {
      kind: "permission",
      req: { toolName: "bash" } as never,
      choices: [],
      index: 0,
    }
    return state
  }

  it.each([32, 48, 140])(
    "keeps approval waiting readable at %i columns with the appropriate banner budget",
    (columns) => {
      const state = waitingState()
      const { container } = wrap(
        <TranscriptRegion
          state={state}
          fullscreen
          banner={null}
          identity={builtinIdentity}
          activeModel="claude-x"
          columns={columns}
          layout={terminalLayout(columns, 24)}
          scroll={scroll()}
          scrollContentRef={{ current: null }}
          cursor={cursor()}
          mutedColor="gray"
        />
      )
      expect(container.textContent).toContain("Waiting for approval")
      expect(container.textContent).toContain("Bash")
      expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
      if (columns === 32) expect(container.textContent).not.toContain("Cognia Agent")
      else expect(container.textContent).toContain(columns === 48 ? "✻ Cognia ·" : "Cognia Agent")
    }
  )

  it("preserves attached external identity and reported context while a newly arrived approval is below the viewport", () => {
    const state = waitingState()
    state.config = { ...state.config, agentBackend: "codex" }
    state.modelMeta = { modelId: "remote-model", contextWindow: 100_000, runtime: true }
    state.usage = { contextTokens: 25_000 }
    const { container } = wrap(
      <TranscriptRegion
        state={state}
        fullscreen
        banner={null}
        identity={{ provider: "codex (attached)", model: "remote-model", external: true }}
        activeModel="claude-x"
        columns={140}
        scroll={scroll({ atBottom: false, hidden: { above: 0, below: 1 }, newRowsBelow: 2 })}
        scrollContentRef={{ current: null }}
        cursor={cursor()}
        mutedColor="gray"
      />
    )
    expect(container.textContent).toContain("codex (attached)")
    expect(container.textContent).toContain("remote-model")
    expect(container.textContent).toContain("25% ctx")
    expect(container.textContent).not.toContain("claude-x")
    expect(container.textContent).toContain("1 more line below · 2 new")
    expect(container.textContent).toContain("Waiting for approval")
    expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
  })

  it.each(["measuring", "fullscreen-backtrack", "scrollback-backtrack"] as const)(
    "keeps the earlier prompt visible during %s without presenting the pending command as executing",
    (mode) => {
      const state = waitingState()
      const activeCursor = cursor()
      if (mode === "measuring") {
        activeCursor.measuring = true
        activeCursor.state.focusedCellId = "c1"
      } else {
        state.backtrack = { index: 0 }
      }
      state.config = {
        ...state.config,
        render: { ...state.config.render, terminalResizeReplayMaxRows: 20 },
      }
      const { container } = wrap(
        <TranscriptRegion
          state={state}
          fullscreen={mode !== "scrollback-backtrack"}
          banner={null}
          identity={builtinIdentity}
          activeModel="claude-x"
          scroll={scroll()}
          scrollContentRef={{ current: null }}
          cursor={activeCursor}
          mutedColor="gray"
        />
      )
      expect(container.textContent).toContain("hello world")
      expect(container.textContent).toContain("Waiting for approval")
      expect(container.textContent).toContain("touch approved.txt")
      expect(hasSpinnerFrame(container.textContent ?? "")).toBe(false)
    }
  )
})
