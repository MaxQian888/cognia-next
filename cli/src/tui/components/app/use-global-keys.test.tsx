import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import { useGlobalKeys, type GlobalKeysDeps } from "./use-global-keys"
import { absoluteTopLeft } from "../../input/element-position"
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

jest.mock("../../input/element-position", () => ({ absoluteTopLeft: jest.fn(() => null) }))
const mockPos = absoluteTopLeft as jest.Mock

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
    cancelBackendConnect: jest.fn(),
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
    composerPopupOpen: { current: false },
    subagentChipRef: { current: null },
    agentTreeRef: { current: null },
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

  it("cycles the permission mode on Shift+Tab and notices what runs without asking", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { tab: true, shift: true }))
    expect(deps.persist).toHaveBeenCalledWith("permissionMode", expect.any(String))
    expect(deps.agent.switchMode).toHaveBeenCalled()
    // The notice carries the mode plus its one-line "runs without asking" summary,
    // and only ever cycles into a safe-core mode (never a power mode).
    const notice = (deps.dispatch as jest.Mock).mock.calls
      .map((c) => c[0])
      .find((a: { type: string }) => a.type === "NOTICE") as { message: string } | undefined
    expect(notice?.message).toMatch(/Permission mode: (default|acceptEdits|plan) —/)
    expect(notice?.message).not.toMatch(/bypassPermissions|dontAsk/)
  })
})

describe("running-agents tree clicks", () => {
  const treeRef = (agents: Array<{ liveId: string; name: string; task: string }>) => ({
    current: { box: {} as never, agents },
  })

  beforeEach(() => mockPos.mockReturnValue({ top: 5, left: 0 }))
  afterEach(() => mockPos.mockReturnValue(null))

  it("opens the clicked agent's run page directly", () => {
    const deps = buildDeps({
      fullscreen: true,
      agentTreeRef: treeRef([{ liveId: "l1", name: "finder", task: "scan the repo" }]),
    })
    render(<Harness deps={deps} />)
    // Tree top at 0-based row 5; SGR row 7 → offset 1 → agent 0's stats line.
    act(() => __fireInput("[<0;5;7M"))
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "OVERLAY_OPEN",
      overlay: { kind: "agentRun", liveId: "l1", name: "finder", task: "scan the repo" },
    })
    expect(deps.runCommandLine).not.toHaveBeenCalled()
  })

  it("maps the second agent's activity line to that agent", () => {
    const deps = buildDeps({
      fullscreen: true,
      agentTreeRef: treeRef([
        { liveId: "l1", name: "a", task: "" },
        { liveId: "l2", name: "b", task: "" },
      ]),
    })
    render(<Harness deps={deps} />)
    // offset 4 (SGR row 10) = second agent's activity line.
    act(() => __fireInput("[<0;5;10M"))
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ overlay: expect.objectContaining({ liveId: "l2" }) })
    )
  })

  it("falls back to the /agents panel on the header line", () => {
    const deps = buildDeps({
      fullscreen: true,
      agentTreeRef: treeRef([{ liveId: "l1", name: "finder", task: "" }]),
    })
    render(<Harness deps={deps} />)
    // offset 0 (SGR row 6) = the "Running N agents…" header.
    act(() => __fireInput("[<0;5;6M"))
    expect(deps.runCommandLine).toHaveBeenCalledWith("/agents")
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "OVERLAY_OPEN" })
    )
  })

  it("ignores clicks above the tree box", () => {
    const deps = buildDeps({
      fullscreen: true,
      agentTreeRef: treeRef([{ liveId: "l1", name: "finder", task: "" }]),
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<0;5;3M"))
    expect(deps.runCommandLine).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "OVERLAY_OPEN" })
    )
  })

  it("does nothing when the tree is not on screen (ref null)", () => {
    const deps = buildDeps({ fullscreen: true })
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<0;5;7M"))
    expect(deps.runCommandLine).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "OVERLAY_OPEN" })
    )
  })
})
