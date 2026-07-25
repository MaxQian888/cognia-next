import React from "react"
import { render } from "@testing-library/react"

import { TranscriptRegion } from "./TranscriptRegion"
import { ThemeProvider } from "../../theme/context"
import { RenderPrefsProvider } from "../../render/context"
import { BUILTIN_THEMES } from "../../theme/builtins"
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
