import React from "react"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
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
  it("does not repeat the welcome banner when resuming a scrollback conversation", () => {
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
    expect(text).not.toContain("BANNER")
    expect(text).toContain("hello world")
  })

  it("hides the fullscreen welcome after the first user message and hides the scroll hint at bottom", () => {
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
    expect(text).not.toContain("Cognia Agent")
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
        cells: [],
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
      expect(container.textContent).not.toContain("Cognia Agent")
      expect(container.textContent).not.toContain("✻ Cognia ·")
    }
  )

  it("hides duplicated attached identity while preserving an approval below the viewport", () => {
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
    expect(container.textContent).not.toContain("codex (attached)")
    expect(container.textContent).not.toContain("remote-model")
    expect(container.textContent).not.toContain("25% ctx")
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

describe("welcome banner lifecycle", () => {
  const region = (state: TuiState, fullscreen: boolean) => (
    <TranscriptRegion
      state={state}
      fullscreen={fullscreen}
      banner={<>WELCOME</>}
      identity={builtinIdentity}
      activeModel="claude-x"
      scroll={scroll()}
      scrollContentRef={{ current: null }}
      cursor={cursor()}
      mutedColor="gray"
    />
  )

  it("shows welcome before user input and hides it immediately after the first send", () => {
    const empty = { ...makeState(), cells: [] }
    const { container, rerender } = render(region(empty, true))
    expect(container.textContent).toContain("Cognia Agent")
    rerender(region(makeState(), true))
    expect(container.textContent).not.toContain("Cognia Agent")
    expect(container.textContent).toContain("hello world")
  })

  it("keeps the existing Static header slot until replay, so the first user cell is not skipped", () => {
    const empty = { ...makeState(), cells: [] }
    const { container, rerender } = render(region(empty, false))
    expect(container.textContent).toContain("WELCOME")
    rerender(region(makeState(), false))
    // The native terminal has already printed this header. Keeping its slot
    // preserves Ink Static's append index; it is not a pinned live banner.
    expect(container.textContent).toContain("WELCOME")
    expect(container.textContent).toContain("hello world")
    rerender(region({ ...makeState(), renderEpoch: 1 }, false))
    expect(container.textContent).not.toContain("WELCOME")
    expect(container.textContent).toContain("hello world")
  })

  it("shows welcome again for a new empty session", () => {
    const { container, rerender } = render(region(makeState(), false))
    expect(container.textContent).not.toContain("WELCOME")
    rerender(region({ ...makeState(), sessionId: "s2", cells: [] }, false))
    expect(container.textContent).toContain("WELCOME")
  })
})

it("does not skip or duplicate user cells when the real Ink Static welcome ends", () => {
  const dir = mkdtempSync(join(process.cwd(), "node_modules/.welcome-static-"))
  const outfile = join(dir, "region.mjs")
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {build} from 'esbuild'; import {render} from 'ink'; import React from 'react';
      import {PassThrough} from 'node:stream'; import assert from 'node:assert/strict';
      await build({stdin:{contents:"export {TranscriptRegion} from './cli/src/tui/components/app/TranscriptRegion'; export {createInitialState} from './cli/src/tui/state/initial'; export {DEFAULT_RESOLVED_CONFIG} from './cli/src/config/schema';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',packages:'external',outfile:${JSON.stringify(outfile)},logLevel:'silent'});
      const {TranscriptRegion,createInitialState,DEFAULT_RESOLVED_CONFIG}=await import(${JSON.stringify(outfile)});
      const stdout=new PassThrough(); stdout.columns=80; stdout.rows=24; stdout.isTTY=false;
      const stdin=new PassThrough(); stdin.isTTY=false; const stderr=new PassThrough();
      let captured=''; stdout.on('data',chunk=>captured+=chunk.toString());
      const base=createInitialState({...DEFAULT_RESOLVED_CONFIG,cwd:'/work'},'s1',true,[]);
      const props={fullscreen:false,banner:React.createElement('ink-text',null,'WELCOME_FIRST'),identity:{provider:'anthropic',model:'test',external:false},activeModel:'test',scroll:{offset:0,atBottom:true,hidden:{above:0,below:0},measure:()=>{}},scrollContentRef:{current:null},cursor:{measuring:false,state:{focusedCellId:null},reportCellHeight:()=>{}},mutedColor:'gray'};
      const view=state=>React.createElement(TranscriptRegion,{...props,state});
      const app=render(view(base),{stdout,stdin,stderr,exitOnCtrlC:false,patchConsole:false});
      const pause=()=>new Promise(resolve=>setTimeout(resolve,50)); await pause();
      const first={id:'first',kind:'user',text:'FIRST_USER'};
      app.rerender(view({...base,cells:[first]})); await pause();
      const second={id:'second',kind:'user',text:'SECOND_USER'};
      app.rerender(view({...base,cells:[first,second]})); await pause();
      assert.equal(captured.split('WELCOME_FIRST').length-1,1,captured);
      assert.equal(captured.split('FIRST_USER').length-1,1,captured);
      assert.equal(captured.split('SECOND_USER').length-1,1,captured);
      captured=''; app.rerender(view({...base,cells:[first,second],renderEpoch:1})); await pause();
      assert.ok(!captured.includes('WELCOME_FIRST'),captured);
      assert.ok(captured.includes('FIRST_USER') && captured.includes('SECOND_USER'),captured);
      app.unmount(); stdout.end(); stdin.end(); stderr.end(); console.log('Static lifecycle passed');
    `,
      ],
      { encoding: "utf8", timeout: 30000 }
    )
    expect(output).toContain("Static lifecycle passed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("updates welcome identity before the first user while retaining the last header slot afterwards", () => {
  const empty = { ...makeState(), cells: [] }
  const view = (state: TuiState, name: string) => (
    <TranscriptRegion
      state={state}
      fullscreen={false}
      banner={<>{name}</>}
      identity={builtinIdentity}
      activeModel="claude-x"
      scroll={scroll()}
      scrollContentRef={{ current: null }}
      cursor={cursor()}
      mutedColor="gray"
    />
  )
  const { container, rerender } = render(view(empty, "router-old"))
  expect(container.textContent).toContain("router-old")
  rerender(view(empty, "router-new"))
  expect(container.textContent).toContain("router-new")
  expect(container.textContent).not.toContain("router-old")
  rerender(view(makeState(), "not-a-new-welcome"))
  expect(container.textContent).toContain("router-new")
  expect(container.textContent).toContain("hello world")
  expect(container.textContent).not.toContain("not-a-new-welcome")
})
