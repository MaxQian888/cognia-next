/**
 * Tests for the fleet hook catalog + settings.json patch logic.
 * The pure group builders are exercised directly; the install/uninstall
 * orchestration mocks the settings wrappers and the Tauri invoke boundary.
 */

import {
  FLEET_HOOKS,
  buildFleetHookGroups,
  classifyFleetInstall,
  fleetHookCommand,
  installFleetHooks,
  isFleetHookHandler,
  readFleetHooksStatus,
  stripFleetGroups,
  uninstallFleetHooks,
  withFleetGroups,
} from "./fleet-hooks"

const invokeMock = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

const readUserMock = jest.fn()
const writeUserMock = jest.fn()
jest.mock("@/lib/claude/settings", () => ({
  readClaudeUserSettings: (...args: unknown[]) => readUserMock(...args),
  writeClaudeUserSettings: (...args: unknown[]) => writeUserMock(...args),
}))

const SCRIPT = "/Users/x/.cognia/agent-monitor/claude-hook.sh"

const scriptsStatus = {
  claudeScript: "installed" as const,
  claudeScriptPath: SCRIPT,
  monitorConfigPresent: true,
}

beforeEach(() => {
  invokeMock.mockReset()
  readUserMock.mockReset()
  writeUserMock.mockReset()
  writeUserMock.mockResolvedValue({ path: "~/.claude/settings.json" })
})

describe("fleetHookCommand / isFleetHookHandler", () => {
  it("builds a quoted command with event and mode args", () => {
    const def = FLEET_HOOKS.find((d) => d.event === "PermissionRequest")!
    expect(fleetHookCommand(SCRIPT, def)).toBe(`"${SCRIPT}" PermissionRequest wait`)
  })

  it("recognizes its own handlers by script path and by stable filename", () => {
    const handler = { type: "command", command: `"${SCRIPT}" PreToolUse fire` }
    expect(isFleetHookHandler(handler, SCRIPT)).toBe(true)
    expect(isFleetHookHandler(handler)).toBe(true)
    expect(isFleetHookHandler({ type: "command", command: "node other.mjs" })).toBe(false)
    expect(isFleetHookHandler({ type: "webhook", url: "https://x" })).toBe(false)
    expect(isFleetHookHandler(null)).toBe(false)
  })
})

describe("buildFleetHookGroups", () => {
  it("creates one group per catalog event with the wait timeout on PermissionRequest", () => {
    const groups = buildFleetHookGroups(SCRIPT)
    expect(Object.keys(groups).sort()).toEqual([...FLEET_HOOKS.map((d) => d.event)].sort())
    const perm = groups.PermissionRequest![0].hooks[0]
    expect(perm).toMatchObject({ type: "command", timeout: 30 })
    const fire = groups.PreToolUse![0].hooks[0]
    expect("timeout" in fire).toBe(false)
  })
})

describe("withFleetGroups / stripFleetGroups", () => {
  const userGroup = {
    matcher: "Bash",
    hooks: [{ type: "command", command: "node /home/me/my-guard.mjs" }],
  }

  it("appends fleet groups after user groups and is idempotent", () => {
    const base = { PreToolUse: [userGroup] }
    const once = withFleetGroups(base, SCRIPT)
    const twice = withFleetGroups(once, SCRIPT)
    expect(twice).toEqual(once)
    const pre = once.PreToolUse as unknown[]
    expect(pre).toHaveLength(2)
    expect(pre[0]).toEqual(userGroup)
  })

  it("strip removes only fleet groups and drops emptied events", () => {
    const merged = withFleetGroups({ PreToolUse: [userGroup] }, SCRIPT)
    const stripped = stripFleetGroups(merged, SCRIPT)
    expect(stripped.PreToolUse).toEqual([userGroup])
    expect(stripped.SessionStart).toBeUndefined()
    expect(stripped.PermissionRequest).toBeUndefined()
  })

  it("strip works without a script path via the stable filename marker", () => {
    const merged = withFleetGroups({}, "/elsewhere/.cognia/agent-monitor/claude-hook.sh")
    expect(Object.keys(stripFleetGroups(merged))).toHaveLength(0)
  })

  it("passes through non-array event values untouched", () => {
    const weird = { PreToolUse: "corrupted" as unknown }
    expect(stripFleetGroups(weird as Record<string, unknown>)).toEqual(weird)
  })
})

describe("classifyFleetInstall", () => {
  it("classifies not-installed / partial / installed", () => {
    expect(classifyFleetInstall(undefined, SCRIPT)).toBe("not-installed")
    expect(classifyFleetInstall({}, SCRIPT)).toBe("not-installed")

    const full = withFleetGroups({}, SCRIPT)
    expect(classifyFleetInstall(full, SCRIPT)).toBe("installed")

    const partial = { ...full }
    delete partial.PermissionRequest
    expect(classifyFleetInstall(partial, SCRIPT)).toBe("partial")
  })
})

describe("installFleetHooks", () => {
  it("regenerates the script then patches user settings preserving other fields", async () => {
    invokeMock.mockResolvedValue(scriptsStatus)
    readUserMock.mockResolvedValue({
      model: "opus",
      permissions: { defaultMode: "ask" },
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "mine" }] }] },
      extra: { customKey: 1 },
    })

    const status = await installFleetHooks()
    expect(status).toEqual(scriptsStatus)
    expect(invokeMock).toHaveBeenCalledWith("fleet_scripts_install")

    const payload = writeUserMock.mock.calls[0][0]
    // Full round-trip: unrelated fields survive.
    expect(payload.model).toBe("opus")
    expect(payload.permissions).toEqual({ defaultMode: "ask" })
    expect(payload.extra).toEqual({ customKey: 1 })
    // User group first, fleet appended; all catalog events present.
    expect(payload.hooks.PreToolUse[0].hooks[0].command).toBe("mine")
    expect(classifyFleetInstall(payload.hooks, SCRIPT)).toBe("installed")
  })

  it("handles a missing settings file by writing a fresh hooks payload", async () => {
    invokeMock.mockResolvedValue(scriptsStatus)
    readUserMock.mockResolvedValue(null)
    await installFleetHooks()
    const payload = writeUserMock.mock.calls[0][0]
    expect(classifyFleetInstall(payload.hooks, SCRIPT)).toBe("installed")
  })

  it("throws when the script path is unavailable", async () => {
    invokeMock.mockResolvedValue({ ...scriptsStatus, claudeScriptPath: null })
    await expect(installFleetHooks()).rejects.toThrow("script path")
    expect(writeUserMock).not.toHaveBeenCalled()
  })
})

describe("uninstallFleetHooks", () => {
  it("strips groups from settings before removing scripts", async () => {
    const order: string[] = []
    readUserMock.mockResolvedValue({ hooks: withFleetGroups({}, SCRIPT) })
    writeUserMock.mockImplementation(async () => {
      order.push("write")
      return { path: "p" }
    })
    invokeMock.mockImplementation(async (cmd: string) => {
      order.push(cmd)
      return { ...scriptsStatus, claudeScript: "missing", monitorConfigPresent: false }
    })

    await uninstallFleetHooks()
    expect(order).toEqual(["write", "fleet_scripts_uninstall"])
    const payload = writeUserMock.mock.calls[0][0]
    expect(Object.keys(payload.hooks)).toHaveLength(0)
  })

  it("skips the settings write when no settings file exists", async () => {
    readUserMock.mockResolvedValue(null)
    invokeMock.mockResolvedValue(scriptsStatus)
    await uninstallFleetHooks()
    expect(writeUserMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith("fleet_scripts_uninstall")
  })
})

describe("readFleetHooksStatus", () => {
  it("reports installed when settings carry all catalog events", async () => {
    invokeMock.mockResolvedValue(scriptsStatus)
    readUserMock.mockResolvedValue({ hooks: withFleetGroups({}, SCRIPT) })
    const status = await readFleetHooksStatus()
    expect(status.install).toBe("installed")
    expect(status.scripts).toEqual(scriptsStatus)
  })

  it("reports not-installed for a missing settings file", async () => {
    invokeMock.mockResolvedValue(scriptsStatus)
    readUserMock.mockResolvedValue(null)
    expect((await readFleetHooksStatus()).install).toBe("not-installed")
  })

  it("reports unavailable when the settings reader throws (no ~/.claude)", async () => {
    invokeMock.mockResolvedValue(scriptsStatus)
    readUserMock.mockRejectedValue(new Error("no ~/.claude directory"))
    expect((await readFleetHooksStatus()).install).toBe("unavailable")
  })
})
