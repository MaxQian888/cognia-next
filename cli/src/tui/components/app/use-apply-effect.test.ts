/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"

import { useApplyEffect, type ApplyEffectDeps } from "./use-apply-effect"
import { createMcpProbeCache } from "../../runtime/mcp-cache"
import { createInitialState } from "../../state/initial"
import { resolveNotices, DEFAULT_RESOLVED_CONFIG } from "../../../config/schema"
import type { ResolvedConfig } from "../../../config/schema"
import type { AgentSessionApi } from "../../hooks/useAgentSession"
import type { TranscriptCursor } from "../../hooks/useTranscriptCursor"
import { runRuntimeRequest } from "../../runtime"
import { CliDbSnapshotError } from "../../../db/bootstrap"

jest.mock("../../runtime", () => ({ runRuntimeRequest: jest.fn(() => Promise.resolve()) }))

const runRuntimeRequestMock = jest.mocked(runRuntimeRequest)

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
    resumeSession: jest.fn(),
    runBash: jest.fn(),
    killBash: jest.fn(() => true),
    foregroundBash: jest.fn(() => true),
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
    startFixRun: jest.fn(() => Promise.resolve()) as never,
    syncAndRefreshModelOverlay: jest.fn(),
    takeSteer: jest.fn(() => null),
    doExit: jest.fn(),
    changeCwd: jest.fn(),
    setRuntimeAbort: jest.fn(),
    getRuntimeAbort: jest.fn(() => null),
    mcpProbeCache: createMcpProbeCache(),
    ...over,
  }
}

const run = (deps: ApplyEffectDeps) => renderHook(() => useApplyEffect(deps)).result.current

describe("useApplyEffect", () => {
  beforeEach(() => runRuntimeRequestMock.mockResolvedValue())

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

  it("persists + live-merges + re-resolves for the flag effect (/route auto on)", () => {
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "route-flag-"))
    try {
      const deps = buildDeps({ home })
      run(deps)({ kind: "flag", key: "autoRoute", value: true })
      // Live-merge into config + re-resolve options so the next turn honors it.
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "SET_CONFIG_PATCH",
        patch: { autoRoute: true },
      })
      expect(deps.agent.invalidate).toHaveBeenCalled()
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "NOTICE",
        message: "autoRoute enabled.",
      })
      // Persisted to config.json on disk.
      const written = JSON.parse(fs.readFileSync(nodePath.join(home, "config.json"), "utf8"))
      expect(written.autoRoute).toBe(true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("sends a prompt for the send effect", () => {
    const deps = buildDeps()
    run(deps)({ kind: "send", prompt: "do it" })
    expect(deps.agent.send).toHaveBeenCalledWith("do it")
  })

  it("does NOT invalidate the session for a read-only /mcp action (panel open)", async () => {
    const deps = buildDeps()
    run(deps)({ kind: "runtime", runtime: { feature: "mcp", action: "panel" } })
    await flush()
    expect(deps.agent.invalidate).not.toHaveBeenCalled()
  })

  it("invalidates the session for a mutating /mcp action (toggle)", async () => {
    const deps = buildDeps()
    run(deps)({ kind: "runtime", runtime: { feature: "mcp", action: "toggle", arg: "x" } })
    await flush()
    expect(deps.agent.invalidate).toHaveBeenCalled()
  })

  it("surfaces an unsafe database snapshot as an error cell", async () => {
    const deps = buildDeps()
    runRuntimeRequestMock.mockRejectedValueOnce(
      new CliDbSnapshotError(
        "Database snapshot is corrupt (invalid JSON). It was preserved at /tmp/db.json.corrupt-1; no data was overwritten.",
        "/tmp/db.json",
        "/tmp/db.json.corrupt-1"
      )
    )

    run(deps)({ kind: "runtime", runtime: { feature: "goal", action: "list" } })
    await flush()

    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "TURN_ERROR",
      message: expect.stringContaining("preserved at /tmp/db.json.corrupt-1"),
      title: "Database restore failed",
    })
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

  it("resumeSession resumes the given session id", () => {
    const deps = buildDeps()
    run(deps)({ kind: "resumeSession", id: "s-42" })
    expect(deps.resumeSession).toHaveBeenCalledWith("s-42")
  })

  it("bashKill kills via the registry and stays quiet on success", () => {
    const deps = buildDeps()
    run(deps)({ kind: "bashKill", id: "bash-1" })
    expect(deps.killBash).toHaveBeenCalledWith("bash-1")
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "That command is no longer running." })
    )
  })

  it("bashKill notices when the run already settled", () => {
    const deps = buildDeps({ killBash: jest.fn(() => false) })
    run(deps)({ kind: "bashKill", id: "bash-9" })
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: "That command is no longer running.",
    })
  })

  it("bashForeground re-foregrounds via the registry, noticing on a miss", () => {
    const deps = buildDeps({ foregroundBash: jest.fn(() => false) })
    run(deps)({ kind: "bashForeground", id: "bash-9" })
    expect(deps.foregroundBash).toHaveBeenCalledWith("bash-9")
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: "That command is no longer running.",
    })
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

  it("live-applies + persists a theme, and repaints the scrollback (scrollback mode)", () => {
    const deps = buildDeps({ fullscreen: false })
    run(deps)({ kind: "theme", theme: "dracula" })
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_THEME", theme: "dracula" })
    expect(deps.persist).toHaveBeenCalledWith("theme", "dracula")
    // `<Static>` freezes already-printed rows — force a re-print so the whole
    // transcript + banner recolour, not just new cells.
    expect(deps.clearScreen).toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "REPAINT" })
  })

  it("does NOT clear/repaint on a theme change in fullscreen (transcript recolours live)", () => {
    const deps = buildDeps({ fullscreen: true })
    run(deps)({ kind: "theme", theme: "dracula" })
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_THEME", theme: "dracula" })
    expect(deps.clearScreen).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalledWith({ type: "REPAINT" })
  })

  it("applies a custom theme and repaints the scrollback (scrollback mode)", () => {
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "custom-theme-"))
    try {
      const deps = buildDeps({ home, fullscreen: false })
      run(deps)({ kind: "customTheme", base: { accent: "#ff0000" } })
      expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_THEME", theme: "custom:cli" })
      expect(deps.clearScreen).toHaveBeenCalled()
      expect(deps.dispatch).toHaveBeenCalledWith({ type: "REPAINT" })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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

  it("starts a fix run and arms the abort controller", () => {
    const deps = buildDeps()
    run(deps)({ kind: "fixRun", testCommand: "pnpm test", maxRounds: 3 })
    expect(deps.startFixRun).toHaveBeenCalledWith(
      expect.objectContaining({ testCommand: "pnpm test", maxRounds: 3 })
    )
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

  describe("changeCwd", () => {
    // config.cwd is "/work"; normalize it the way the handler does so the
    // assertions hold on every platform's path semantics.
    const base = nodePath.resolve(config.cwd)

    it("switches to a valid directory and notices the new cwd", () => {
      jest.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as never)
      const deps = buildDeps()
      const target = nodePath.resolve(config.cwd, "sub")
      run(deps)({ kind: "changeCwd", dir: "sub" })
      expect(deps.changeCwd).toHaveBeenCalledWith(target)
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "NOTICE",
        message: `Working directory: ${target}`,
      })
    })

    it("rejects a non-directory path without switching", () => {
      jest.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("ENOENT")
      })
      const deps = buildDeps()
      run(deps)({ kind: "changeCwd", dir: "nope" })
      expect(deps.changeCwd).not.toHaveBeenCalled()
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "NOTICE",
          message: expect.stringContaining("Not a directory"),
        })
      )
    })

    it("no-ops when the target resolves to the current cwd", () => {
      jest.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as never)
      const deps = buildDeps()
      run(deps)({ kind: "changeCwd", dir: base })
      expect(deps.changeCwd).not.toHaveBeenCalled()
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "NOTICE", message: `Already in ${base}` })
      )
    })

    afterEach(() => jest.restoreAllMocks())
  })
})
