import { renderHook } from "@testing-library/react"

import { useApplyEffect, type ApplyEffectDeps } from "./use-apply-effect"
import { createInitialState } from "../../state/initial"
import { resolveNotices, DEFAULT_RESOLVED_CONFIG } from "../../../config/schema"
import type { ResolvedConfig } from "../../../config/schema"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const flush = () => new Promise((r) => setTimeout(r, 0))

function buildDeps(over: Partial<ApplyEffectDeps> = {}): ApplyEffectDeps {
  const agent = {
    send: jest.fn(),
    compact: jest.fn(),
    clear: jest.fn(),
    listCheckpoints: jest.fn(() => []),
    rewind: jest.fn(),
    invalidate: jest.fn(),
    switchMode: jest.fn(),
    switchAgentMode: jest.fn(),
  } as unknown as AgentSessionApi
  return {
    agent,
    dispatch: jest.fn(),
    state: createInitialState(config, "s1", true, []),
    home: "/home",
    osHome: "/oshome",
    mintId: () => "new-id",
    clearScreen: jest.fn(),
    scrollReset: jest.fn(),
    cursor: { clear: jest.fn() } as unknown as TranscriptCursor,
    copyClipboard: jest.fn(async () => ({ ok: true }) as never),
    notices: resolveNotices(undefined),
    pushHandoff: jest.fn(),
    openSessions: jest.fn(),
    resumeMostRecent: jest.fn(),
    runBash: jest.fn(),
    takeLastFailedBash: jest.fn(() => null),
    persistStatusBar: jest.fn(),
    persistMascot: jest.fn(),
    persistEditor: jest.fn(),
    openInEditorFn: jest.fn(async () => true),
    runShell: jest.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    persist: jest.fn(() => true),
    persistDb: jest.fn(),
    fullscreen: false,
    screen: {} as never,
    startGoalRun: jest.fn(() => Promise.resolve()) as never,
    startLoopRun: jest.fn(() => Promise.resolve()) as never,
    syncAndRefreshModelOverlay: jest.fn(),
    takeSteer: jest.fn(() => null),
    doExit: jest.fn(),
    setRuntimeAbort: jest.fn(),
    getRuntimeAbort: jest.fn(() => null),
    ...over,
  }
}

const run = (deps: ApplyEffectDeps) => renderHook(() => useApplyEffect(deps)).result.current

describe("useApplyEffect", () => {
  it("dispatches a NOTICE for the notice effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "notice", message: "hi" })
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "hi" })
  })

  it("ignores the none effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "none" })
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it("sends a prompt for the send effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "send", prompt: "do it" })
    expect(deps.agent.send).toHaveBeenCalledWith("do it")
  })

  it("opens an overlay and refreshes the model picker for a model overlay", () => {
    const deps = buildDeps()
    run(deps)({ kind: "openOverlay", overlay: { kind: "model", options: [], index: 0, query: "" } })
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "OVERLAY_OPEN" }))
    expect(deps.syncAndRefreshModelOverlay).toHaveBeenCalled()
  })

  it("clears the terminal + session for the clear effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "clear" })
    expect(deps.clearScreen).toHaveBeenCalled()
    expect(deps.scrollReset).toHaveBeenCalled()
    expect(deps.cursor.clear).toHaveBeenCalled()
    expect(deps.agent.clear).toHaveBeenCalledWith("new-id")
  })

  it("copies via the clipboard and notices the result", async () => {
    const deps = buildDeps()
    run(deps)({ kind: "copy", text: "yo" })
    await flush()
    expect(deps.copyClipboard).toHaveBeenCalledWith("yo")
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "NOTICE", message: deps.notices.copiedReply })
    )
  })

  it("runs a bash command for the runBash effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "runBash", command: "ls" })
    expect(deps.runBash).toHaveBeenCalledWith("ls")
  })

  it("notices when there is no failed command to analyze", () => {
    const deps = buildDeps({ takeLastFailedBash: jest.fn(() => null) })
    run(deps)({ kind: "analyzeBash" })
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: "No failed command to analyze.",
    })
  })

  it("sends an analysis prompt when there is a failed command", () => {
    const deps = buildDeps({
      takeLastFailedBash: jest.fn(() => ({ command: "false", output: "boom", exitCode: 1 })),
    })
    run(deps)({ kind: "analyzeBash" })
    expect(deps.agent.send).toHaveBeenCalled()
  })

  it("live-applies + persists a theme", () => {
    const deps = buildDeps()
    run(deps)({ kind: "theme", theme: "dracula" })
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_THEME", theme: "dracula" })
    expect(deps.persist).toHaveBeenCalledWith("theme", "dracula")
  })

  it("persists the status bar patch", () => {
    const deps = buildDeps()
    run(deps)({ kind: "statusBar", patch: { theme: "ascii" } as never })
    expect(deps.persistStatusBar).toHaveBeenCalledWith("/home", { theme: "ascii" })
  })

  it("starts a goal run and arms the abort controller", () => {
    const deps = buildDeps()
    run(deps)({ kind: "goalRun", objective: "ship it" })
    expect(deps.startGoalRun).toHaveBeenCalled()
    expect(deps.setRuntimeAbort).toHaveBeenCalledWith(expect.any(AbortController))
  })

  it("exits for the exit effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "exit" })
    expect(deps.doExit).toHaveBeenCalled()
  })

  it("delegates session listing + resume", () => {
    const deps = buildDeps()
    run(deps)({ kind: "openSessions" })
    run(deps)({ kind: "resumeLast" })
    expect(deps.openSessions).toHaveBeenCalled()
    expect(deps.resumeMostRecent).toHaveBeenCalled()
  })
})
