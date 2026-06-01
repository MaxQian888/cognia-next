/**
 * Tests for the Terminal Plugin API (`ctx.terminal`).
 *
 * Covers permission gating (terminal:spawn/write/kill) and — critically —
 * ownership enforcement: a plugin may only touch sessions it spawned.
 */

import { createTerminalAPI, TerminalAccessError } from "./terminal-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import {
  __resetCompletionRegistryForTesting,
  getCompletions,
  listProviders,
} from "@/lib/terminal/completion/registry"
import type { TerminalCompletionContext } from "@/lib/terminal/completion/types"

const spawnFromDock = jest.fn(async (..._a: unknown[]) => ({}) as unknown)
const killFromDock = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (...a: unknown[]) => spawnFromDock(...a),
  killFromDock: (...a: unknown[]) => killFromDock(...a),
}))

const liveSessions = new Map<string, { write: jest.Mock; onData: jest.Mock }>()
jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: (id: string) => liveSessions.get(id),
}))

// --- terminal store mock -------------------------------------------------
let storeSessions: Record<string, unknown> = {}
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ sessions: storeSessions }) },
}))

const PLUGIN = "term-plugin"
const OTHER = "other-plugin"

function addStoreRow(id: string, extensionId: string, extra: Record<string, unknown> = {}) {
  storeSessions[id] = {
    id,
    extensionId,
    shell: "pwsh",
    cwd: "/w",
    status: "idle",
    lastCommands: [],
    ...extra,
  }
}

describe("createTerminalAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    storeSessions = {}
    liveSessions.clear()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  describe("permission gating", () => {
    it("spawn needs terminal:spawn", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createTerminalAPI(PLUGIN)
      // The guard proxy throws synchronously before the async body runs.
      expect(() => api.spawn()).toThrow(PermissionError)
    })

    it("write needs terminal:write; kill needs terminal:kill", () => {
      guard.registerPlugin(PLUGIN, ["terminal:spawn"])
      addStoreRow("t1", PLUGIN)
      liveSessions.set("t1", { write: jest.fn(async () => undefined), onData: jest.fn() })
      const api = createTerminalAPI(PLUGIN)
      expect(() => api.write("t1", "ls")).toThrow(PermissionError)
      expect(() => api.kill("t1")).toThrow(PermissionError)
    })
  })

  describe("spawn", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["terminal:spawn"]))

    it("tags the spawn with the plugin id and returns id + shell", async () => {
      spawnFromDock.mockResolvedValue({ kind: "spawned", sessionId: "t9", shell: "bash" })
      const api = createTerminalAPI(PLUGIN)
      const res = await api.spawn({ cwd: "/repo", shell: "bash" })
      expect(res).toEqual({ id: "t9", shell: "bash" })
      expect(spawnFromDock).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.objectContaining({ extensionId: PLUGIN, cwd: "/repo", shell: "bash" }),
        })
      )
    })

    it("throws on policy denial and on transport error", async () => {
      const api = createTerminalAPI(PLUGIN)
      spawnFromDock.mockResolvedValueOnce({ kind: "denied", reason: "blocked" })
      await expect(api.spawn()).rejects.toThrow(TerminalAccessError)
      spawnFromDock.mockResolvedValueOnce({ kind: "error", message: "no transport" })
      await expect(api.spawn()).rejects.toThrow(/no transport/)
    })
  })

  describe("ownership enforcement", () => {
    beforeEach(() =>
      guard.registerPlugin(PLUGIN, ["terminal:spawn", "terminal:write", "terminal:kill"])
    )

    it("write/kill/onData/readRecent reject a session owned by another plugin", async () => {
      addStoreRow("foreign", OTHER)
      liveSessions.set("foreign", { write: jest.fn(), onData: jest.fn() })
      const api = createTerminalAPI(PLUGIN)
      await expect(api.write("foreign", "x")).rejects.toThrow(TerminalAccessError)
      await expect(api.kill("foreign")).rejects.toThrow(TerminalAccessError)
      expect(() => api.onData("foreign", () => {})).toThrow(TerminalAccessError)
      expect(() => api.readRecent("foreign")).toThrow(TerminalAccessError)
      expect(killFromDock).not.toHaveBeenCalled()
    })

    it("rejects an unknown session id", async () => {
      const api = createTerminalAPI(PLUGIN)
      await expect(api.write("ghost", "x")).rejects.toThrow(/unknown session/)
    })

    it("allows operations on an owned session", async () => {
      addStoreRow("mine", PLUGIN, {
        lastCommands: [
          { cmd: "a", exitCode: 0, endedAt: 1 },
          { cmd: "b", exitCode: 1, endedAt: 2 },
        ],
      })
      const write = jest.fn(async () => undefined)
      const onData = jest.fn(() => () => undefined)
      liveSessions.set("mine", { write, onData })
      const api = createTerminalAPI(PLUGIN)

      await api.write("mine", "ls")
      expect(write).toHaveBeenCalledWith("ls")

      const handler = () => {}
      api.onData("mine", handler)
      expect(onData).toHaveBeenCalledWith(handler)

      expect(api.readRecent("mine", 1)).toEqual([{ cmd: "b", exitCode: 1, endedAt: 2 }])

      await api.kill("mine")
      expect(killFromDock).toHaveBeenCalledWith("mine", expect.anything())
    })
  })

  describe("list", () => {
    it("returns only sessions owned by this plugin", () => {
      guard.registerPlugin(PLUGIN, ["terminal:spawn"])
      addStoreRow("a", PLUGIN)
      addStoreRow("b", OTHER)
      addStoreRow("c", PLUGIN, { status: "running" })
      const api = createTerminalAPI(PLUGIN)
      const list = api.list()
      expect(list.map((s) => s.id).sort()).toEqual(["a", "c"])
      expect(list.find((s) => s.id === "c")?.status).toBe("running")
    })
  })

  describe("runScript", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["terminal:spawn"]))

    it("spawns the right interpreter for a script, tagged to the plugin", async () => {
      spawnFromDock.mockResolvedValue({ kind: "spawned", sessionId: "r1", shell: "python3" })
      const api = createTerminalAPI(PLUGIN)
      const res = await api.runScript("/repo/main.py", { args: ["--fast"] })
      expect(res).toEqual({ id: "r1", shell: "python3" })
      expect(spawnFromDock).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.objectContaining({
            shell: "python3",
            args: ["/repo/main.py", "--fast"],
            extensionId: PLUGIN,
          }),
        })
      )
    })

    it("requires terminal:spawn", () => {
      guard.registerPlugin(OTHER, [])
      const api = createTerminalAPI(OTHER)
      expect(() => api.runScript("x.sh")).toThrow(PermissionError)
    })

    it("rejects an undetectable script", async () => {
      const api = createTerminalAPI(PLUGIN)
      await expect(api.runScript("mystery.bin")).rejects.toThrow(/cannot determine/i)
    })
  })

  describe("detectScriptType", () => {
    it("resolves an interpreter without spawning", () => {
      guard.registerPlugin(PLUGIN, ["terminal:spawn"])
      const api = createTerminalAPI(PLUGIN)
      expect(api.detectScriptType("deploy.sh")?.interpreter).toBe("bash")
      expect(api.detectScriptType("x.txt", "#!/usr/bin/env node")?.kind).toBe("node")
      expect(spawnFromDock).not.toHaveBeenCalled()
    })
  })

  describe("registerCompletionProvider", () => {
    beforeEach(() => __resetCompletionRegistryForTesting())

    function ctx(): TerminalCompletionContext {
      return {
        sessionId: "s1",
        shell: "bash",
        shellPath: "/bin/bash",
        cwd: "/x",
        input: "git ",
        cursor: 4,
        recentCommands: [],
        platform: "linux",
      }
    }

    it("requires terminal:completion", () => {
      guard.registerPlugin(PLUGIN, ["terminal:spawn"])
      const api = createTerminalAPI(PLUGIN)
      expect(() =>
        api.registerCompletionProvider({ id: "x", label: "X", getCompletions: () => [] })
      ).toThrow(PermissionError)
    })

    it("registers a namespaced plugin-sourced provider and disposes it", async () => {
      guard.registerPlugin(PLUGIN, ["terminal:completion"])
      const api = createTerminalAPI(PLUGIN)
      const off = api.registerCompletionProvider({
        id: "fig",
        label: "Fig",
        getCompletions: () => [{ text: "git status" }],
      })
      expect(listProviders().map((p) => p.id)).toContain(`${PLUGIN}:fig`)
      const out = await getCompletions(ctx(), new AbortController().signal)
      expect(out[0]).toMatchObject({ text: "git status", source: "plugin" })
      off()
      expect(listProviders().map((p) => p.id)).not.toContain(`${PLUGIN}:fig`)
    })
  })
})
