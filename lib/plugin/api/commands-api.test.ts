/**
 * @jest-environment jsdom
 *
 * `ctx.commands`. The interesting behaviour is not that it registers a
 * command, it is that it registers one the SAME way `manifest.commands[]`
 * does: namespaced, first-wins across plugins, and gone when the plugin is.
 */

const loadCustom = jest.fn(async () => [] as unknown[])
const saveCustom = jest.fn(async () => "/Users/me/.claude/commands/x.md")
const deleteCustom = jest.fn(async () => undefined)

jest.mock("@/lib/slash-commands/custom", () => ({
  ...jest.requireActual("@/lib/slash-commands/custom"),
  loadCustomSlashCommands: (...a: unknown[]) => loadCustom(...(a as [])),
  saveCustomSlashCommand: (...a: unknown[]) => saveCustom(...(a as [])),
  deleteCustomSlashCommand: (...a: unknown[]) => deleteCustom(...(a as [])),
}))

const activeRoot = jest.fn(() => "/repo" as string | undefined)
jest.mock("@/lib/plugin/api/workspace-root", () => ({
  getActiveWorkspaceRoot: () => activeRoot(),
}))

import { createCommandsAPI, namespacedCommandId } from "./commands-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import {
  __resetSlashCommandsForTesting,
  dispatchSlashCommand,
  getSlashCommand,
  listSlashCommands,
  registerSlashCommand,
} from "@/lib/slash-commands/registry"

const PLUGIN = "acme.tools"

function trackerFor() {
  const disposers: Array<() => void> = []
  const track = jest.fn((dispose: () => void) => {
    disposers.push(dispose)
    return dispose
  })
  return { track, disposeAll: () => disposers.splice(0).forEach((d) => d()) }
}

function apiFor(permissions: string[], tracker = trackerFor()) {
  getPermissionGuard().registerPlugin(PLUGIN, permissions as never)
  return {
    api: createCommandsAPI(PLUGIN, { track: tracker.track, resolveWorkspaceRoot: activeRoot }),
    tracker,
  }
}

beforeEach(() => {
  resetPermissionGuard()
  __resetSlashCommandsForTesting()
  loadCustom.mockReset().mockResolvedValue([])
  saveCustom.mockReset().mockResolvedValue("/Users/me/.claude/commands/x.md")
  deleteCustom.mockReset().mockResolvedValue(undefined)
  activeRoot.mockReset().mockReturnValue("/repo")
})

describe("registerSlashCommand", () => {
  it("namespaces the id exactly like the manifest path", async () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    api.registerSlashCommand({
      id: "deploy",
      description: "Ship it",
      handler: () => ({ message: "shipped" }),
    })

    expect(namespacedCommandId(PLUGIN, "deploy")).toBe("acme.tools.deploy")
    expect(getSlashCommand("acme.tools.deploy")).toMatchObject({
      name: "deploy",
      description: "Ship it",
      source: "plugin",
      pluginId: PLUGIN,
    })
    await expect(dispatchSlashCommand("/acme.tools.deploy now")).resolves.toEqual({
      message: "shipped",
    })
  })

  it("registers aliases as separate ids sharing one handler", async () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    const handler = jest.fn(() => ({ message: "ok" }))
    api.registerSlashCommand({ id: "deploy", aliases: ["ship", "SHIP", "deploy"], handler })

    // Deduped, lower-cased, and the command's own id is never an alias of itself.
    const aliasIds = listSlashCommands()
      .map((definition) => definition.id)
      .filter((id) => id.includes("#alias:"))
    expect(aliasIds).toEqual(["acme.tools.deploy#alias:ship"])
    // The typeable token, not a decorated label.
    expect(getSlashCommand(aliasIds[0])?.name).toBe("ship")
    await dispatchSlashCommand(`/${aliasIds[0]}`)
    expect(handler).toHaveBeenCalled()
  })

  it("leaves an incumbent plugin's command alone and registers no aliases behind it", () => {
    registerSlashCommand({
      id: "acme.tools.deploy",
      name: "deploy",
      source: "plugin",
      pluginId: "someone.else",
      handler: () => ({ message: "incumbent" }),
    })
    const { api } = apiFor(["commands:read", "commands:write"])
    const dispose = api.registerSlashCommand({
      id: "deploy",
      aliases: ["ship"],
      handler: () => ({ message: "mine" }),
    })

    expect(getSlashCommand("acme.tools.deploy")?.pluginId).toBe("someone.else")
    expect(getSlashCommand("acme.tools.deploy#alias:ship")).toBeUndefined()
    // The returned disposer is still safe to call.
    expect(() => dispose()).not.toThrow()
    expect(getSlashCommand("acme.tools.deploy")?.pluginId).toBe("someone.else")
  })

  it("is torn down with the plugin, disposer called or not", () => {
    const { api, tracker } = apiFor(["commands:read", "commands:write"])
    api.registerSlashCommand({ id: "deploy", aliases: ["ship"], handler: () => ({}) })
    expect(tracker.track).toHaveBeenCalledWith(
      expect.any(Function),
      "ctx.commands.registerSlashCommand:acme.tools.deploy"
    )
    expect(listSlashCommands()).toHaveLength(2)

    tracker.disposeAll()
    expect(listSlashCommands()).toHaveLength(0)
  })

  it("refuses a missing id or a non-function handler", () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    expect(() => api.registerSlashCommand({ id: "  ", handler: () => ({}) })).toThrow(/id/)
    expect(() => api.registerSlashCommand({ id: "x", handler: undefined as never })).toThrow(
      /handler/
    )
  })

  it("normalises a handler that returns nothing into an empty result", async () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    api.registerSlashCommand({ id: "quiet", handler: () => undefined })
    await expect(dispatchSlashCommand("/acme.tools.quiet")).resolves.toEqual({})
  })
})

describe("unregisterSlashCommand", () => {
  it("removes this plugin's own command, by short or namespaced id", () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    api.registerSlashCommand({ id: "a", handler: () => ({}) })
    api.registerSlashCommand({ id: "b", handler: () => ({}) })

    expect(api.unregisterSlashCommand("a")).toBe(true)
    expect(api.unregisterSlashCommand("acme.tools.b")).toBe(true)
    expect(listSlashCommands()).toHaveLength(0)
  })

  it("refuses to remove a command this plugin does not own", () => {
    registerSlashCommand({
      id: "acme.tools.foreign",
      name: "foreign",
      source: "plugin",
      pluginId: "someone.else",
      handler: () => ({}),
    })
    const { api } = apiFor(["commands:read", "commands:write"])
    expect(api.unregisterSlashCommand("foreign")).toBe(false)
    expect(getSlashCommand("acme.tools.foreign")).toBeDefined()
  })
})

describe("permission gating", () => {
  /**
   * The guard denies on the synchronous fast path when nothing is granted, so
   * an async method rejects by throwing rather than by returning a rejected
   * promise. Assert on either shape.
   */
  const denied = async (call: () => unknown) => {
    try {
      await call()
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionError)
      return
    }
    throw new Error("expected a PermissionError")
  }

  it("refuses every method without the matching permission", async () => {
    const { api } = apiFor([])
    await denied(() => api.registerSlashCommand({ id: "a", handler: () => ({}) }))
    await denied(() => api.unregisterSlashCommand("a"))
    await denied(() => api.listSlashCommands())
    await denied(() => api.listCustomCommands())
    await denied(() => api.getCustomCommand("a"))
    await denied(() => api.saveCustomCommand({ name: "a", body: "b" }))
    await denied(() => api.deleteCustomCommand({ name: "a" }))
  })

  it("lets a read-only plugin list without letting it write", async () => {
    const { api } = apiFor(["commands:read"])
    expect(api.listSlashCommands()).toEqual([])
    await expect(api.listCustomCommands()).resolves.toEqual([])
    await denied(() => api.registerSlashCommand({ id: "a", handler: () => ({}) }))
    await denied(() => api.saveCustomCommand({ name: "a", body: "b" }))
  })
})

describe("custom command files", () => {
  it("lists and gets through the shared scanner, defaulting to the open workspace", async () => {
    loadCustom.mockResolvedValue([
      {
        name: "deploy",
        description: "Ship",
        scope: "project",
        template: "body",
        originDir: "/repo/.cognia/commands",
        filePath: "/repo/.cognia/commands/deploy.md",
        handler: () => undefined,
      },
    ])
    const { api } = apiFor(["commands:read", "commands:write"])

    const listed = await api.listCustomCommands()
    expect(loadCustom).toHaveBeenCalledWith("/repo")
    // The handler slot never crosses the boundary: a command file has no code.
    expect(listed[0]).toEqual({
      name: "deploy",
      description: "Ship",
      scope: "project",
      template: "body",
      originDir: "/repo/.cognia/commands",
      filePath: "/repo/.cognia/commands/deploy.md",
    })
    await expect(api.getCustomCommand("deploy")).resolves.toMatchObject({ name: "deploy" })
    await expect(api.getCustomCommand("missing")).resolves.toBeUndefined()
  })

  it("writes an edited command back to the directory it came from", async () => {
    loadCustom.mockResolvedValue([
      { name: "deploy", description: "d", scope: "project", originDir: "/repo/.cognia/commands" },
    ])
    const { api } = apiFor(["commands:read", "commands:write"])

    await api.saveCustomCommand({ name: "deploy", body: "new body" })
    expect(saveCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deploy",
        scope: "project",
        cwd: "/repo",
        dir: ".cognia/commands",
        body: "new body",
      })
    )
  })

  it("defaults a new command to .claude/commands", async () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    await api.saveCustomCommand({ name: "fresh", body: "b" })
    expect(saveCustom).toHaveBeenCalledWith(
      expect.objectContaining({ dir: ".claude/commands", scope: "project" })
    )
  })

  it("validates the name before any filesystem call", async () => {
    const { api } = apiFor(["commands:read", "commands:write"])
    await expect(api.saveCustomCommand({ name: "../escape", body: "b" })).rejects.toThrow()
    await expect(api.deleteCustomCommand({ name: "../escape" })).rejects.toThrow()
    expect(saveCustom).not.toHaveBeenCalled()
    expect(deleteCustom).not.toHaveBeenCalled()
  })

  it("deletes in the scope and directory the file is actually in", async () => {
    loadCustom.mockResolvedValue([
      { name: "old", description: "d", scope: "user", originDir: "/Users/me/.claude/commands" },
    ])
    const { api } = apiFor(["commands:read", "commands:write"])
    await api.deleteCustomCommand({ name: "old" })
    expect(deleteCustom).toHaveBeenCalledWith({
      scope: "user",
      name: "old",
      cwd: "/repo",
      dir: ".claude/commands",
    })
  })
})
