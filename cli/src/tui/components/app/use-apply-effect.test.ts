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
jest.mock("../../runtime/lifecycle-firer", () => ({
  createCliLifecycleFirer: () => async () => null,
}))

let testHome: string
beforeEach(() => {
  testHome = fs.mkdtempSync(nodePath.join(os.tmpdir(), "effect-controls-"))
})
afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true })
})

const runRuntimeRequestMock = jest.mocked(runRuntimeRequest)

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }
const flush = () => new Promise((r) => setTimeout(r, 0))

function buildDeps(over: Partial<ApplyEffectDeps> = {}): ApplyEffectDeps {
  const agent = {
    send: jest.fn(),
    abort: jest.fn(),
    compact: jest.fn(),
    clear: jest.fn(),
    listCheckpoints: jest.fn(() => []),
    rewind: jest.fn(),
    invalidate: jest.fn(),
    switchMode: jest.fn(),
    switchAgentMode: jest.fn(),
    switchBackend: jest.fn(),
  } as unknown as AgentSessionApi
  return {
    agent,
    dispatch: jest.fn(),
    state: createInitialState(config, "s1", true, []),
    home: testHome,
    osHome: testHome,
    mintId: () => "new-id",
    clearScreen: jest.fn(),
    scrollReset: jest.fn(),
    cursor: { clear: jest.fn() } as unknown as TranscriptCursor,
    copyClipboard: jest.fn(async () => ({ ok: true }) as never),
    notices: resolveNotices(undefined),
    pushHandoff: jest.fn(),
    openSessions: jest.fn(),
    openModelPicker: jest.fn(),
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
    selectionRef: { current: null },
    startGoalRun: jest.fn(() => Promise.resolve()) as never,
    startLoopRun: jest.fn(() => Promise.resolve()) as never,
    startFixRun: jest.fn(() => Promise.resolve()) as never,
    syncAndRefreshModelOverlay: jest.fn(),
    takeSteer: jest.fn(() => null),
    doExit: jest.fn(),
    changeCwd: jest.fn(),
    reclaimBackend: jest.fn(),
    setRuntimeAbort: jest.fn(),
    getRuntimeAbort: jest.fn(() => null),
    mcpProbeCache: createMcpProbeCache(),
    ...over,
  }
}

const run = (deps: ApplyEffectDeps) => renderHook(() => useApplyEffect(deps)).result.current

describe("useApplyEffect", () => {
  it("does not send refinement if the backend cannot enter read-only plan mode", async () => {
    const deps = buildDeps()
    jest.mocked(deps.agent.switchMode).mockRejectedValueOnce(new Error("mode unavailable"))
    run(deps)({ kind: "planRefine", feedback: "Revise the plan" })
    await flush()
    expect(deps.agent.send).not.toHaveBeenCalled()
    expect(deps.persist).not.toHaveBeenCalled()
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: "Plan refinement failed: mode unavailable",
    })
  })
  it("refines the reviewed plan with the user's explicit instructions after entering plan mode", async () => {
    const deps = buildDeps()
    deps.state.lastPlan = { raw: "# Revised Plan\n1. Keep the API", seq: 2 }
    run(deps)({ kind: "planRefine", feedback: "Add a migration rollback step" })
    await flush()
    expect(deps.agent.switchMode).toHaveBeenCalledWith("plan")
    expect(deps.agent.send).toHaveBeenCalledWith(
      expect.stringContaining("# Revised Plan\n1. Keep the API")
    )
    expect(deps.agent.send).toHaveBeenCalledWith(
      expect.stringContaining("Add a migration rollback step")
    )
  })
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

  describe("backend switch", () => {
    it("reconnects to an external backend without an explicit reclaim", () => {
      // The reconnect reuses the stable agent id and reclaims the old process as
      // it re-registers, so an explicit reclaim here would race that.
      const deps = buildDeps({ state: createInitialState(config, "s1", true, []) })
      run(deps)({ kind: "backend", backend: "codex" })

      expect(deps.agent.switchBackend).toHaveBeenCalledWith("codex")
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "BACKEND_CONNECT_RETRY",
        backend: "codex",
      })
      expect(deps.reclaimBackend).not.toHaveBeenCalled()
    })

    it("reclaims the external process when switching to the built-in agent", () => {
      // Nothing reconnects, so the old external process would leak until exit.
      const state = createInitialState({ ...config, agentBackend: "codex" }, "s1", true, [])
      const deps = buildDeps({ state })
      run(deps)({ kind: "backend", backend: "builtin" })

      expect(deps.agent.switchBackend).toHaveBeenCalledWith("builtin")
      expect(deps.reclaimBackend).toHaveBeenCalledTimes(1)
      expect(deps.dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "BACKEND_CONNECT_RETRY" })
      )
    })
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

  it("routes attached-mode effects through the HostState lifecycle callbacks", async () => {
    const attachHost = jest.fn(async () => "attached")
    const detachHost = jest.fn(async () => "detached")
    const hostSyncStatus = jest.fn(async () => "healthy")
    const deps = buildDeps({ attachHost, detachHost, hostSyncStatus })
    const apply = run(deps)

    apply({ kind: "attachHost", targetId: "desktop-a", sessionId: "s-1" })
    apply({ kind: "hostSyncStatus" })
    apply({ kind: "detachHost" })
    await flush()

    expect(attachHost).toHaveBeenCalledWith({ targetId: "desktop-a", sessionId: "s-1" })
    expect(hostSyncStatus).toHaveBeenCalledTimes(1)
    expect(detachHost).toHaveBeenCalledTimes(1)
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "attached" })
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "healthy" })
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "detached" })
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
    expect(deps.persistStatusBar).toHaveBeenCalledWith(deps.home, { theme: "ascii" })
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

  describe("selection effect (/select)", () => {
    function selectionDeps(over: Partial<ApplyEffectDeps> = {}) {
      const writes: string[] = []
      const deps = buildDeps({
        fullscreen: true,
        screen: { isTTY: true, write: (d: string) => writes.push(d) } as never,
        ...over,
      })
      return { deps, writes }
    }

    it("live-applies the mode, drops the highlight, and persists", () => {
      const clear = jest.fn()
      const { deps, writes } = selectionDeps({ selectionRef: { current: { clear } as never } })
      run(deps)({ kind: "selection", mode: "auto-copy" })
      expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_SELECTION", mode: "auto-copy" })
      expect(clear).toHaveBeenCalled()
      expect(deps.persist).toHaveBeenCalledWith("selection", "auto-copy")
      // Button-event tracking (?1002h) must go on with the feature.
      expect(writes.join("")).toContain("\x1b[?1002h")
    })

    it("releases drag reporting when the mode goes back to off", () => {
      const { deps, writes } = selectionDeps()
      run(deps)({ kind: "selection", mode: "off" })
      expect(writes.join("")).toContain("\x1b[?1002l")
      expect(writes.join("")).not.toContain("\x1b[?1002h")
    })

    it("notices each mode in plain language", () => {
      const { deps } = selectionDeps()
      run(deps)({ kind: "selection", mode: "manual" })
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "NOTICE",
        message: expect.stringContaining("Selection: manual"),
      })
    })

    it("still applies the mode when persistence fails", () => {
      const { deps } = selectionDeps({ persist: jest.fn(() => false) })
      run(deps)({ kind: "selection", mode: "manual" })
      expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_SELECTION", mode: "manual" })
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "NOTICE",
        message: "Selection mode updated (couldn't save to config).",
      })
    })

    it("writes no escapes outside the fullscreen layout", () => {
      const { deps, writes } = selectionDeps({ fullscreen: false })
      run(deps)({ kind: "selection", mode: "manual" })
      expect(writes).toEqual([])
      expect(deps.persist).toHaveBeenCalledWith("selection", "manual")
    })

    it("keeps drag reporting on across a /mouse switch while selection is on", () => {
      const state = { ...createInitialState(config, "s1", true, []) }
      state.config = { ...state.config, selection: "auto-copy" }
      const { deps, writes } = selectionDeps({ state })
      run(deps)({ kind: "mouse", mode: "scroll" })
      expect(writes.join("")).toContain("\x1b[?1002h")
    })

    it("switches mouse=select to tracked scroll mode when selection is enabled", () => {
      const state = { ...createInitialState(config, "s1", true, []) }
      state.config = { ...state.config, mouse: "select", selection: "off" }
      const { deps, writes } = selectionDeps({ state })

      run(deps)({ kind: "selection", mode: "manual" })

      expect(deps.dispatch).toHaveBeenCalledWith({ type: "SET_MOUSE", mode: "scroll" })
      expect(deps.persist).toHaveBeenCalledWith("mouse", "scroll")
      expect(writes.join("")).toContain("\x1b[?1002h")
    })
  })

  describe("permissionMode", () => {
    const notices = (deps: ApplyEffectDeps): string[] =>
      (deps.dispatch as jest.Mock).mock.calls
        .map((c) => c[0])
        .filter((a: { type: string }) => a.type === "NOTICE")
        .map((a: { message: string }) => a.message)

    it("applies a safe mode: persist + switchMode + a consequence notice", () => {
      const deps = buildDeps()
      run(deps)({ kind: "permissionMode", mode: "acceptEdits" })
      expect(deps.persist).toHaveBeenCalledWith("permissionMode", "acceptEdits")
      expect(deps.agent.switchMode).toHaveBeenCalledWith("acceptEdits")
      expect(notices(deps)[0]).toMatch(/Permission mode: acceptEdits — /)
    })

    it("opens the acknowledgement instead of applying bypass", () => {
      const deps = buildDeps()
      run(deps)({ kind: "permissionMode", mode: "bypassPermissions" })
      expect(deps.agent.switchMode).not.toHaveBeenCalled()
      expect(deps.persist).not.toHaveBeenCalled()
      expect(deps.dispatch).toHaveBeenCalledWith({
        type: "OVERLAY_OPEN",
        overlay: expect.objectContaining({
          kind: "confirm",
          onConfirmCommand: "mode bypassPermissions --force",
        }),
      })
    })

    it("applies bypass once forced, and records the acknowledgement", () => {
      const deps = buildDeps()
      run(deps)({ kind: "permissionMode", mode: "bypassPermissions", force: true })
      expect(deps.agent.switchMode).toHaveBeenCalledWith("bypassPermissions")
      expect(deps.dispatch).toHaveBeenCalledWith({ type: "BYPASS_ACK" })
    })

    it("does not persist a launch-only bypass mode after confirmation", () => {
      const deps = buildDeps({ sessionOnlyPermissionMode: "bypassPermissions" })
      run(deps)({ kind: "permissionMode", mode: "bypassPermissions", force: true })

      expect(deps.agent.switchMode).toHaveBeenCalledWith("bypassPermissions")
      expect(deps.persist).not.toHaveBeenCalledWith("permissionMode", "bypassPermissions")
    })

    it("keeps the startup bypass decline session-only too", () => {
      const deps = buildDeps({ sessionOnlyPermissionMode: "bypassPermissions" })
      run(deps)({ kind: "permissionMode", mode: "default" })

      expect(deps.agent.switchMode).toHaveBeenCalledWith("default")
      expect(deps.persist).not.toHaveBeenCalledWith("permissionMode", "default")
    })

    it("stops asking after the session acknowledged once", () => {
      const state = { ...createInitialState(config, "s1", true, []), bypassAcknowledged: true }
      const deps = buildDeps({ state })
      run(deps)({ kind: "permissionMode", mode: "bypassPermissions" })
      expect(deps.agent.switchMode).toHaveBeenCalledWith("bypassPermissions")
    })

    it("still applies the mode when persistence fails", () => {
      const deps = buildDeps({ persist: jest.fn(() => false) })
      run(deps)({ kind: "permissionMode", mode: "plan" })
      expect(deps.agent.switchMode).toHaveBeenCalledWith("plan")
      expect(notices(deps)).toContain("Permission mode updated (couldn't save to config).")
    })

    it("says so when the backend can't enforce the picked mode", () => {
      // An `a2a` transport has no client-side approval loop, so the manager
      // clamps bypass down to `default` before the agent ever sees it.
      const base = createInitialState(config, "s1", true, [])
      const deps = buildDeps({
        state: {
          ...base,
          bypassAcknowledged: true,
          backendCapabilities: {
            backend: "remote",
            builtin: false,
            protocol: "a2a",
            features: {} as never,
          },
        },
      })
      run(deps)({ kind: "permissionMode", mode: "bypassPermissions" })
      expect(notices(deps)).toContainEqual(
        expect.stringContaining("remote can't enforce bypassPermissions — it runs under default")
      )
    })

    it("stays quiet about clamping when the backend honours the mode", () => {
      const base = createInitialState(config, "s1", true, [])
      const deps = buildDeps({
        state: {
          ...base,
          bypassAcknowledged: true,
          backendCapabilities: {
            backend: "codex-app-server",
            builtin: false,
            protocol: "codex-app-server",
            features: {} as never,
          },
        },
      })
      run(deps)({ kind: "permissionMode", mode: "bypassPermissions" })
      expect(notices(deps).join("\n")).not.toMatch(/can't enforce/)
    })
  })
})

describe("foreground goal/loop controls", () => {
  const loop = {
    kind: "loop" as const,
    mode: "interval" as const,
    prompt: "check",
    maxIterations: 3,
  }
  const goalControl = (action: string) => ({
    kind: "runtime" as const,
    runtime: { feature: "goal" as const, action },
  })
  function controls() {
    let current: AbortController | null = null
    const deps = buildDeps({
      getRuntimeAbort: () => current,
      setRuntimeAbort: jest.fn((value) => {
        current = value
      }),
    })
    return { deps, apply: run(deps) }
  }

  it("resumes a persisted goal through the streaming runner, not the status-only router", async () => {
    const { deps, apply } = controls()
    apply(goalControl("resume"))
    expect(deps.startGoalRun).toHaveBeenCalledWith("", expect.objectContaining({ resume: true }))
    expect(runRuntimeRequestMock).not.toHaveBeenCalled()
    await flush()
  })

  it("waits for a paused loop to settle, preserves continuation and rejects duplicate resume", async () => {
    const { deps, apply } = controls()
    let finish!: () => void
    jest.mocked(deps.startLoopRun).mockImplementationOnce((input) => {
      input.continuation!.completed = 2
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    apply(loop)
    const signal = jest.mocked(deps.startLoopRun).mock.calls[0][0].signal
    apply({ kind: "loopControl", action: "pause" })
    expect(signal.aborted).toBe(true)
    expect(deps.agent.abort).toHaveBeenCalledTimes(1)
    apply({ kind: "loopControl", action: "resume" })
    apply({ kind: "loopControl", action: "resume" })
    expect(deps.startLoopRun).toHaveBeenCalledTimes(1)
    finish()
    await flush()
    expect(deps.startLoopRun).toHaveBeenCalledTimes(2)
    expect(deps.startLoopRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "resume",
        continuation: { completed: 2 },
        maxIterations: 3,
      })
    )
  })

  it("stops a paused loop without another turn and clears the continuation", async () => {
    const { deps, apply } = controls()
    jest.mocked(deps.startLoopRun).mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          input.continuation!.loopId = "l1"
          input.signal.addEventListener("abort", () => resolve(), { once: true })
        })
    )
    apply(loop)
    apply({ kind: "loopControl", action: "pause" })
    await flush()
    apply({ kind: "loopControl", action: "stop" })
    await flush()
    expect(deps.startLoopRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "stop",
        continuation: { loopId: "l1" },
      })
    )
    apply({ kind: "loopControl", action: "resume" })
    expect(deps.startLoopRun).toHaveBeenCalledTimes(2)
    expect(deps.dispatch).toHaveBeenCalledWith({
      type: "NOTICE",
      message: "No paused loop run in this session.",
    })
  })

  it("allows retrying a failed persisted stop instead of leaving a dead stopping state", async () => {
    const { deps, apply } = controls()
    jest.mocked(deps.startLoopRun).mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), { once: true })
        })
    )
    apply(loop)
    apply({ kind: "loopControl", action: "pause" })
    await flush()
    jest.mocked(deps.startLoopRun).mockRejectedValueOnce(new Error("db busy"))
    apply({ kind: "loopControl", action: "stop" })
    await flush()
    apply({ kind: "loopControl", action: "stop" })
    await flush()
    expect(deps.startLoopRun).toHaveBeenCalledTimes(3)
    expect(deps.dispatch).toHaveBeenCalledWith({ type: "NOTICE", message: "Loop stopped." })
  })

  it("persists stop after a loop has exited with an error", async () => {
    const { deps, apply } = controls()
    jest.mocked(deps.startLoopRun).mockImplementationOnce(async (input) => {
      input.continuation!.loopId = "failed-loop"
      input.dispatch({ type: "ACTIVITY_END", status: "error", summary: "Turn failed" })
    })
    apply(loop)
    await flush()
    apply({ kind: "loopControl", action: "stop" })
    await flush()
    expect(deps.startLoopRun).toHaveBeenCalledTimes(2)
    expect(deps.startLoopRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "stop", continuation: { loopId: "failed-loop" } })
    )
    expect(deps.agent.send).not.toHaveBeenCalled()
  })

  it("persists stop after a goal runner rejects", async () => {
    const { deps, apply } = controls()
    jest.mocked(deps.startGoalRun).mockRejectedValueOnce(new Error("Turn failed"))
    apply({ kind: "goalRun", objective: "ship" })
    await flush()
    apply(goalControl("stop"))
    await flush()
    expect(runRuntimeRequestMock).toHaveBeenCalledWith(
      { feature: "goal", action: "stop" },
      expect.anything()
    )
    expect(deps.startGoalRun).toHaveBeenCalledTimes(1)
    expect(deps.agent.send).not.toHaveBeenCalled()
  })

  it("stop supersedes a queued resume before the old goal settles", async () => {
    const { deps, apply } = controls()
    let finish!: () => void
    jest.mocked(deps.startGoalRun).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    apply({ kind: "goalRun", objective: "ship" })
    apply(goalControl("pause"))
    apply(goalControl("resume"))
    apply(goalControl("stop"))
    finish()
    await flush()
    expect(deps.startGoalRun).toHaveBeenCalledTimes(1)
    expect(runRuntimeRequestMock).toHaveBeenCalledWith(
      { feature: "goal", action: "stop" },
      expect.anything()
    )
  })

  it("keeps the loop cancellation owner while a status request runs", async () => {
    const { deps, apply } = controls()
    let finish!: () => void
    jest.mocked(deps.startLoopRun).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    apply(loop)
    const owner = deps.getRuntimeAbort()
    apply(goalControl("status"))
    await flush()
    expect(deps.getRuntimeAbort()).toBe(owner)
    apply({ kind: "loopControl", action: "stop" })
    expect(owner!.signal.aborted).toBe(true)
    finish()
    await flush()
    expect(deps.getRuntimeAbort()).toBeNull()
  })

  it.each(["pause", "resume", "stop"] as const)(
    "reports %s with no loop without running anything",
    (action) => {
      const { deps, apply } = controls()
      apply({ kind: "loopControl", action })
      expect(deps.startLoopRun).not.toHaveBeenCalled()
      expect(deps.agent.abort).not.toHaveBeenCalled()
      expect(deps.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("No ") })
      )
    }
  )

  it("rejects a second foreground start and cleans up a rejected runner", async () => {
    const { deps, apply } = controls()
    jest.mocked(deps.startGoalRun).mockRejectedValueOnce(new Error("boom"))
    apply({ kind: "goalRun", objective: "ship" })
    apply(loop)
    expect(deps.startLoopRun).not.toHaveBeenCalled()
    await flush()
    expect(deps.getRuntimeAbort()).toBeNull()
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Run failed: boom" })
    )
  })
})
