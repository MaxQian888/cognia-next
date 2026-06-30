import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { useGlobalKeys, type GlobalKeysDeps } from "./use-global-keys"
import { createInitialState } from "../../state/initial"
import { resolveKeybindings } from "../../input/keybindings"
import {
  resolveNotices,
  resolveRenderConfig,
  DEFAULT_RESOLVED_CONFIG,
} from "../../../config/schema"
import { bufferFromText } from "../../input/buffer"
import type { ResolvedConfig } from "../../../config/schema"
import type { TuiState } from "../../state/types"
import type { ScrollController } from "../../hooks/useScroll"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { AskUserOverlayApi } from "../../hooks/use-ask-user-overlay"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

function buildDeps(over: Partial<GlobalKeysDeps> = {}): GlobalKeysDeps {
  const state: TuiState = { ...createInitialState(config, "s1", true, []), ...over.state }
  return {
    state,
    dispatch: jest.fn(),
    overlayOpen: false,
    busy: false,
    fullscreen: false,
    mouseMode: "scroll",
    notices: resolveNotices(undefined),
    keybindings: resolveKeybindings(undefined),
    renderPrefs: resolveRenderConfig(undefined),
    now: () => 1000,
    doExit: jest.fn(),
    agent: { abort: jest.fn(), switchMode: jest.fn() } as unknown as AgentSessionApi,
    abortRuntime: jest.fn(),
    askUser: { resolve: jest.fn() } as unknown as AskUserOverlayApi,
    hasForegroundRun: jest.fn(() => false),
    killForegroundBash: jest.fn(() => false),
    backgroundForegroundBash: jest.fn(() => false),
    copyClipboard: jest.fn(async () => ({ ok: true }) as never),
    runCommandLine: jest.fn(),
    openModelPicker: jest.fn(),
    persist: jest.fn(() => true),
    pasteClipboardImage: jest.fn(async () => {}),
    scrollReset: jest.fn(),
    disarmBacktrack: jest.fn(),
    armBacktrack: jest.fn(),
    cursor: { state: { find: null } } as unknown as TranscriptCursor,
    scroll: {} as unknown as ScrollController,
    clearScreen: jest.fn(),
    ctrlCTimer: { current: null },
    composerPopupOpen: { current: false },
    subagentChipRef: { current: null },
    footerRowRef: { current: null },
    footerSegmentsRef: { current: null },
    scrollContentRef: { current: null },
    backtrackArmedRef: { current: false },
    ...over,
  }
}

function Harness({ deps }: { deps: GlobalKeysDeps }) {
  useGlobalKeys(deps)
  return null
}

afterEach(() => __resetInk())

describe("useGlobalKeys", () => {
  it("clears the draft on Ctrl+C when the composer holds text", () => {
    const deps = buildDeps({
      state: {
        ...createInitialState(config, "s1", true, []),
        input: {
          ...createInitialState(config, "s1", true, []).input,
          buffer: bufferFromText("hi"),
        },
      } as TuiState,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("c", { ctrl: true }))
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "INPUT_CLEAR" })
  })

  it("primes exit on the first empty Ctrl+C", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("c", { ctrl: true }))
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NOTICE", message: "Press Ctrl+C again to exit" })
    )
  })

  it("exits on a double Ctrl+C inside the window", () => {
    const deps = buildDeps({
      state: { ...createInitialState(config, "s1", true, []), lastCtrlCAt: 500 } as TuiState,
      now: () => 1000,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("c", { ctrl: true }))
    expect(deps.doExit).toHaveBeenCalled()
  })

  it("kills a foreground bash run on Ctrl+C", () => {
    const deps = buildDeps({
      hasForegroundRun: jest.fn(() => true),
      killForegroundBash: jest.fn(() => true),
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("c", { ctrl: true }))
    expect(deps.killForegroundBash).toHaveBeenCalled()
  })

  it("ignores non-Ctrl+C keys during the startup gate", () => {
    const deps = buildDeps({
      state: { ...createInitialState(config, "s1", false, []) } as TuiState,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { escape: true }))
    expect(deps.armBacktrack).not.toHaveBeenCalled()
  })

  it("arms then enters backtrack on idle double-Esc", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { escape: true }))
    expect(deps.armBacktrack).toHaveBeenCalled()
    deps.backtrackArmedRef.current = true
    act(() => __fireInput("", { escape: true }))
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "BACKTRACK_ENTER" })
  })

  it("interrupts a live turn on Esc", () => {
    const deps = buildDeps({ busy: true })
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { escape: true }))
    expect(deps.agent.abort).toHaveBeenCalled()
    expect(deps.abortRuntime).toHaveBeenCalled()
  })

  it("toggles all collapse on the collapseAll chord (Ctrl+T)", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("t", { ctrl: true }))
    expect(deps.clearScreen).toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "TOGGLE_COLLAPSE_ALL" })
  })

  it("cycles the permission mode on Shift+Tab", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { tab: true, shift: true }))
    expect(deps.persist).toHaveBeenCalledWith("permissionMode", expect.any(String))
    expect(deps.agent.switchMode).toHaveBeenCalled()
  })
})
