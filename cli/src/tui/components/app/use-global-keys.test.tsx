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
import type { SelectionController } from "../../selection/selection-controller"
import { TuiInputProvider, useModalInput } from "../../input/input-router"

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
    selectionMode: "off",
    selection: { current: null },
    screenRows: () => [],
    fileExists: () => false,
    openFileAt: jest.fn(),
    notices: resolveNotices(undefined),
    keybindings: resolveKeybindings(undefined),
    renderPrefs: resolveRenderConfig(undefined),
    now: () => 1000,
    doExit: jest.fn(),
    cancelBackendConnect: jest.fn(),
    cancelBackendInstall: jest.fn(),
    agent: { abort: jest.fn(), switchMode: jest.fn() } as unknown as AgentSessionApi,
    abortRuntime: jest.fn(),
    askUser: { resolve: jest.fn() } as unknown as AskUserOverlayApi,
    hasForegroundRun: jest.fn(() => false),
    killForegroundBash: jest.fn(() => false),
    backgroundForegroundBash: jest.fn(() => false),
    copyClipboard: jest.fn(async () => ({ ok: true }) as never),
    runCommandLine: jest.fn(),
    openModelPicker: jest.fn(),
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

function ModalHarness({ onInput }: { onInput: () => void }) {
  useModalInput(onInput)
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

  it("interrupts a live turn on Ctrl+C even when the composer has a draft", () => {
    const initial = createInitialState(config, "s1", true, [])
    const deps = buildDeps({
      busy: true,
      state: {
        ...initial,
        turnStatus: "streaming",
        input: { ...initial.input, buffer: bufferFromText("queued draft") },
      } as TuiState,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("c", { ctrl: true }))
    expect(deps.agent.abort).toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalledWith({ type: "INPUT_CLEAR" })
  })

  it("routes Ctrl+C through the critical path before a modal exactly once", () => {
    const deps = buildDeps({ busy: true, overlayOpen: true })
    const onModalInput = jest.fn()
    render(
      <TuiInputProvider>
        <Harness deps={deps} />
        <ModalHarness onInput={onModalInput} />
      </TuiInputProvider>
    )

    act(() => __fireInput("c", { ctrl: true }))

    expect(deps.agent.abort).toHaveBeenCalledTimes(1)
    expect(deps.abortRuntime).toHaveBeenCalledTimes(1)
    expect(onModalInput).not.toHaveBeenCalled()
  })

  it("interrupts a live turn on Esc while a permission overlay is open", () => {
    const initial = createInitialState(config, "s1", true, [])
    const deps = buildDeps({
      busy: true,
      overlayOpen: true,
      state: {
        ...initial,
        turnStatus: "streaming",
        overlay: {
          kind: "permission",
          req: { requestId: "req-1", toolName: "bash", input: {} },
          choices: [{ label: "Allow once", value: "allow" }],
          index: 0,
        },
      } as unknown as TuiState,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { escape: true }))
    expect(deps.agent.abort).toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "OVERLAY_CLOSE" })
  })

  it("toggles all collapse on the collapseAll chord (Ctrl+T)", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("t", { ctrl: true }))
    expect(deps.clearScreen).toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "TOGGLE_COLLAPSE_ALL" })
  })

  // Shift+Tab no longer persists/switches inline: it runs `/mode <next>` so the
  // persist + notice + danger-tier acknowledgement have ONE implementation.
  it("cycles the permission mode on Shift+Tab through the command path", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { tab: true, shift: true }))
    expect(deps.runCommandLine).toHaveBeenCalledWith("/mode acceptEdits")
  })

  it("cycles into bypassPermissions at the end of the cycle (the confirm gates it)", () => {
    const base = createInitialState(config, "s1", true, [])
    const deps = buildDeps({
      state: { ...base, config: { ...base.config, permissionMode: "plan" } } as TuiState,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { tab: true, shift: true }))
    expect(deps.runCommandLine).toHaveBeenCalledWith("/mode bypassPermissions")
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

/** A stub selection controller that records what the key handler asked it to do. */
function fakeSelection(over: Partial<SelectionController> = {}) {
  return {
    handleMouse: jest.fn(() => false),
    hasSelection: jest.fn(() => false),
    copySelection: jest.fn(() => false),
    clear: jest.fn(() => false),
    dispose: jest.fn(),
    ...over,
  } satisfies SelectionController
}

describe("useGlobalKeys — text selection", () => {
  it("routes mouse events to the selection controller and stops when it consumes one", () => {
    const selection = fakeSelection({ handleMouse: jest.fn(() => true) })
    const deps = buildDeps({
      fullscreen: true,
      selectionMode: "auto-copy",
      selection: { current: selection },
      scroll: { lineUp: jest.fn(), lineDown: jest.fn() } as unknown as ScrollController,
    })
    render(<Harness deps={deps} />)
    // A wheel notch the selection claims must NOT also scroll the transcript.
    act(() => __fireInput("[<64;5;3M"))
    expect(selection.handleMouse).toHaveBeenCalledWith({ kind: "wheel", dir: "up" })
    expect(deps.scroll.lineUp).not.toHaveBeenCalled()
  })

  it("lets an unclaimed wheel notch keep scrolling the transcript", () => {
    const selection = fakeSelection()
    const deps = buildDeps({
      fullscreen: true,
      selection: { current: selection },
      scroll: { lineUp: jest.fn(), lineDown: jest.fn() } as unknown as ScrollController,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<64;5;3M"))
    expect(deps.scroll.lineUp).toHaveBeenCalled()
  })

  it("Esc clears a live selection instead of interrupting", () => {
    const selection = fakeSelection({ clear: jest.fn(() => true) })
    const deps = buildDeps({
      fullscreen: true,
      busy: true,
      selection: { current: selection },
      agent: { abort: jest.fn(), switchMode: jest.fn() } as unknown as AgentSessionApi,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { escape: true }))
    expect(selection.clear).toHaveBeenCalled()
    expect(deps.agent.abort).not.toHaveBeenCalled()
  })

  it("Esc falls through to the interrupt when nothing is selected", () => {
    const selection = fakeSelection()
    const deps = buildDeps({
      fullscreen: true,
      busy: true,
      selection: { current: selection },
      agent: { abort: jest.fn(), switchMode: jest.fn() } as unknown as AgentSessionApi,
    })
    render(<Harness deps={deps} />)
    act(() => __fireInput("", { escape: true }))
    expect(deps.agent.abort).toHaveBeenCalled()
  })

  it("the copy chord copies the selection", () => {
    const selection = fakeSelection({ copySelection: jest.fn(() => true) })
    const deps = buildDeps({ selection: { current: selection } })
    render(<Harness deps={deps} />)
    act(() => __fireInput("s", { ctrl: true }))
    expect(selection.copySelection).toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Nothing selected") })
    )
  })

  it("the copy chord says so when nothing is selected", () => {
    const deps = buildDeps({ selection: { current: fakeSelection() } })
    render(<Harness deps={deps} />)
    act(() => __fireInput("s", { ctrl: true }))
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: resolveNotices(undefined).noSelectionToCopy,
    })
  })
})

describe("useGlobalKeys — Ctrl+click smart action", () => {
  const ROWS = ["edited src/app.ts:12 today", "https://example.com/x", "just prose here"]

  function clickDeps(over: Partial<GlobalKeysDeps> = {}) {
    return buildDeps({
      fullscreen: true,
      screenRows: () => ROWS,
      fileExists: (candidate) => candidate === "src/app.ts",
      openFileAt: jest.fn(),
      ...over,
    })
  }

  it("opens the file under the pointer, with its line", () => {
    const deps = clickDeps()
    render(<Harness deps={deps} />)
    // Ctrl+click (button 16) at row 1, col 11 → inside "src/app.ts:12".
    act(() => __fireInput("[<16;11;1M"))
    expect(deps.openFileAt).toHaveBeenCalledWith("src/app.ts", 12, undefined)
  })

  it("copies the URL under the pointer", () => {
    const deps = clickDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<16;5;2M"))
    expect(deps.copyClipboard).toHaveBeenCalledWith("https://example.com/x")
    expect(deps.openFileAt).not.toHaveBeenCalled()
  })

  it("falls back to copying the whole row", () => {
    const deps = clickDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<16;3;3M"))
    expect(deps.copyClipboard).toHaveBeenCalledWith("just prose here")
  })

  it("ignores a Ctrl+click on a row the frame does not have", () => {
    const deps = clickDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<16;3;9M"))
    expect(deps.copyClipboard).not.toHaveBeenCalled()
    expect(deps.openFileAt).not.toHaveBeenCalled()
  })

  it("leaves a plain (unmodified) click to the existing handlers", () => {
    const deps = clickDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("[<0;11;1M"))
    expect(deps.openFileAt).not.toHaveBeenCalled()
    expect(deps.copyClipboard).not.toHaveBeenCalled()
  })
})

describe("useGlobalKeys — copy family and mode chords", () => {
  const cells = [
    { id: "u1", kind: "user" as const, text: "my question" },
    { id: "a1", kind: "assistant" as const, raw: "an answer\n\n```ts\nconst x = 1\n```" },
  ]

  function withCells(over: Partial<GlobalKeysDeps> = {}) {
    const base = createInitialState(config, "s1", true, [])
    return buildDeps({ state: { ...base, cells } as TuiState, ...over })
  }

  it("Ctrl+X Ctrl+U copies the last user message", () => {
    const deps = withCells()
    render(<Harness deps={deps} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("u", { ctrl: true }))
    expect(deps.copyClipboard).toHaveBeenCalledWith("my question")
  })

  it("Ctrl+X Ctrl+B copies the last code block", () => {
    const deps = withCells()
    render(<Harness deps={deps} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("b", { ctrl: true }))
    expect(deps.copyClipboard).toHaveBeenCalledWith("const x = 1")
  })

  it("Ctrl+X Ctrl+A copies the whole conversation as markdown", () => {
    const deps = withCells()
    render(<Harness deps={deps} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("a", { ctrl: true }))
    const copied = (deps.copyClipboard as jest.Mock).mock.calls[0][0] as string
    expect(copied).toContain("## User\n\nmy question")
    expect(copied).toContain("## Assistant")
  })

  it("reports when there is nothing to copy", () => {
    const deps = buildDeps()
    render(<Harness deps={deps} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("u", { ctrl: true }))
    expect(deps.copyClipboard).not.toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: resolveNotices(undefined).noUserMessageToCopy,
    })
  })

  it("Ctrl+X Ctrl+P swaps the mouse model", () => {
    const deps = buildDeps({ mouseMode: "scroll" })
    render(<Harness deps={deps} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("p", { ctrl: true }))
    expect(deps.runCommandLine).toHaveBeenCalledWith("/mouse select")
  })

  it("Ctrl+X Ctrl+S cycles the selection mode and wraps around", () => {
    const off = buildDeps({ selectionMode: "off" })
    render(<Harness deps={off} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("s", { ctrl: true }))
    expect(off.runCommandLine).toHaveBeenCalledWith("/select manual")

    const last = buildDeps({ selectionMode: "auto-copy" })
    render(<Harness deps={last} />)
    act(() => __fireInput("x", { ctrl: true }))
    act(() => __fireInput("s", { ctrl: true }))
    expect(last.runCommandLine).toHaveBeenCalledWith("/select off")
  })
})
