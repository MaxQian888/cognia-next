import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"
import type { BotRunContextV1 } from "@/types/bot/run"

import { createPythonBackedProxy } from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { __resetBotsForTesting, getBot, listBotIds } from "@/lib/plugin/registries/bot-registry"
import { BotRunParkedError } from "@/lib/bot/runtime/step"
import { pendingParks, recordPendingPark } from "@/lib/bot/runtime/host-step"

import { registerBotsForPlugin, unregisterBotsForPlugin } from "./bots-bridge"

jest.mock("@/lib/plugin/bridge/_shared/python-backed-proxy", () => ({
  ...jest.requireActual("@/lib/plugin/bridge/_shared/python-backed-proxy"),
  createPythonBackedProxy: jest.fn(),
}))

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: { manager: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

const mockCreateProxy = createPythonBackedProxy as jest.MockedFunction<
  typeof createPythonBackedProxy
>

const manifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  ({
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: ["bot"],
    main: "index.js",
    ...overrides,
  }) as PluginManifest

function bot(overrides: Partial<PluginBotDef> & Pick<PluginBotDef, "id">): PluginBotDef {
  return {
    name: overrides.id,
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "manual", kind: "manual" }],
    ...overrides,
  } as PluginBotDef
}

const runContext = { runId: "run_1", installationId: "inst_1", botId: "acme:h" } as BotRunContextV1

beforeEach(() => {
  __resetBotsForTesting()
  mockCreateProxy.mockReset()
  pendingParks.clear()
})

describe("registerBotsForPlugin", () => {
  it("does nothing when the manifest declares no bots", async () => {
    const result = await registerBotsForPlugin(manifest({}), "/root")
    expect(result).toEqual({ registered: 0, errors: [] })
    expect(listBotIds()).toEqual([])
  })

  it("registers a data-only executor without importing anything", async () => {
    const importer = jest.fn()
    const result = await registerBotsForPlugin(
      manifest({ bots: [bot({ id: "wf", executor: "workflow", workflow: "wf_1" })] }),
      "/root",
      { importer }
    )

    expect(result.registered).toBe(1)
    expect(importer).not.toHaveBeenCalled()
    const registered = getBot("acme:wf")
    expect(registered?.definition.id).toBe("wf")
    expect(registered?.handler).toBeUndefined()
  })

  it("resolves a JS handler from the named export", async () => {
    const handler = jest.fn()
    const importer = jest.fn().mockResolvedValue({ myBot: handler })

    await registerBotsForPlugin(
      manifest({ bots: [bot({ id: "h", entry: "./bots/h.js", export: "myBot" })] }),
      "/root",
      { importer }
    )

    expect(importer).toHaveBeenCalledWith(expect.stringContaining("bots/h.js"))
    expect(getBot("acme:h")?.handler).toBe(handler)
  })

  it("defaults to the `default` export when none is named", async () => {
    const handler = jest.fn()
    const importer = jest.fn().mockResolvedValue({ default: handler })

    await registerBotsForPlugin(
      manifest({ bots: [bot({ id: "h", entry: "./bots/h.js" })] }),
      "/root",
      { importer }
    )

    expect(getBot("acme:h")?.handler).toBe(handler)
  })

  it("reports a handler bot whose export is missing, and keeps the others", async () => {
    const good = jest.fn()
    const importer = jest.fn(async (entry: string) =>
      entry.includes("good") ? { default: good } : { notAHandler: 42 }
    )

    const result = await registerBotsForPlugin(
      manifest({
        bots: [
          bot({ id: "bad", entry: "./bots/bad.js" }),
          bot({ id: "good", entry: "./bots/good.js" }),
        ],
      }),
      "/root",
      { importer }
    )

    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ pluginId: "acme", botId: "bad" })
    expect(result.errors[0].message).toContain("default")
    expect(listBotIds()).toEqual(["acme:good"])
  })

  it("refuses a JS-backed handler that declares no entry", async () => {
    const result = await registerBotsForPlugin(manifest({ bots: [bot({ id: "h" })] }), "/root", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain('must declare "entry"')
  })

  it("hands a python handler a serialisable snapshot, never the context", async () => {
    const run = jest.fn().mockResolvedValue({ summary: "done" })
    mockCreateProxy.mockReturnValue({ run } as never)

    await registerBotsForPlugin(manifest({ type: "python", bots: [bot({ id: "h" })] }), "/root", {
      importer: jest.fn(),
    })

    expect(mockCreateProxy).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "acme", contributionId: "h", methods: ["run"] })
    )

    const handler = getBot("acme:h")?.handler
    expect(handler).toBeDefined()
    await handler?.({
      ...runContext,
      event: { eventId: "e1" } as never,
      config: { a: 1 },
      signal: new AbortController().signal,
      step: {} as never,
      log: jest.fn(),
      progress: jest.fn(),
    })

    const snapshot = run.mock.calls[0][0]
    expect(snapshot).toEqual({
      runId: "run_1",
      installationId: "inst_1",
      botId: "acme:h",
      event: { eventId: "e1" },
      config: { a: 1 },
    })
    // The unserialisable half must not leak across the boundary.
    expect(snapshot).not.toHaveProperty("step")
    expect(snapshot).not.toHaveProperty("signal")
  })

  async function pythonHandler(run: jest.Mock) {
    mockCreateProxy.mockReturnValue({ run } as never)
    await registerBotsForPlugin(manifest({ type: "python", bots: [bot({ id: "h" })] }), "/root", {
      importer: jest.fn(),
    })
    return getBot("acme:h")!.handler!
  }

  it("throws a recorded park even when the python run resolved", async () => {
    const run = jest.fn(async () => {
      recordPendingPark(new BotRunParkedError("run_1", "publish", 999, "interrupt"))
      return { summary: "done" }
    })
    const handler = await pythonHandler(run)

    await expect(handler(runContext as never)).rejects.toBeInstanceOf(BotRunParkedError)
    expect(pendingParks.get("run_1")).toBeUndefined()
  })

  it("lets a recorded park win over a proxy error", async () => {
    const parked = new BotRunParkedError("run_1", "ci", 999)
    const run = jest.fn(async () => {
      recordPendingPark(parked)
      throw new Error("transport died")
    })
    const handler = await pythonHandler(run)

    await expect(handler(runContext as never)).rejects.toBe(parked)
  })

  it("propagates the proxy error when no park was recorded", async () => {
    const run = jest.fn(async () => {
      throw new Error("transport died")
    })
    const handler = await pythonHandler(run)

    await expect(handler(runContext as never)).rejects.toThrow("transport died")
  })

  it("treats an explicit backend:'python' on a JS plugin as python-backed", async () => {
    mockCreateProxy.mockReturnValue({ run: jest.fn() } as never)
    const importer = jest.fn()

    await registerBotsForPlugin(
      manifest({ bots: [bot({ id: "h", backend: "python" })] }),
      "/root",
      { importer }
    )

    expect(importer).not.toHaveBeenCalled()
    expect(getBot("acme:h")?.handler).toBeDefined()
  })

  it("drops prior registrations before re-registering, so re-enable cannot go stale", async () => {
    const first = jest.fn()
    const second = jest.fn()

    await registerBotsForPlugin(
      manifest({ bots: [bot({ id: "h", entry: "./h.js" }), bot({ id: "gone", entry: "./g.js" })] }),
      "/root",
      { importer: jest.fn().mockResolvedValue({ default: first }) }
    )
    expect(listBotIds().sort()).toEqual(["acme:gone", "acme:h"])

    await registerBotsForPlugin(manifest({ bots: [bot({ id: "h", entry: "./h.js" })] }), "/root", {
      importer: jest.fn().mockResolvedValue({ default: second }),
    })

    expect(listBotIds()).toEqual(["acme:h"])
    expect(getBot("acme:h")?.handler).toBe(second)
  })
})

describe("unregisterBotsForPlugin", () => {
  it("drops only the named plugin's bots", async () => {
    const importer = jest.fn().mockResolvedValue({ default: jest.fn() })
    await registerBotsForPlugin(manifest({ bots: [bot({ id: "a", entry: "./a.js" })] }), "/root", {
      importer,
    })
    await registerBotsForPlugin(
      manifest({ id: "beta", bots: [bot({ id: "b", entry: "./b.js" })] }),
      "/root",
      { importer }
    )

    unregisterBotsForPlugin("acme")
    expect(listBotIds()).toEqual(["beta:b"])
  })
})

describe("the in-tree reference plugin crosses this bridge", () => {
  // `bots-bridge` and the bot registry shipped with no plugin exercising them.
  // Every test above builds its own manifest, so all of them would still pass
  // if the one real contribution in the tree were malformed. This is the case
  // that reads the shipped manifest and the shipped module.
  it("resolves the Schedule digest handler out of the real manifest and module", async () => {
    const [schedulerManifest, schedulerModule] = await Promise.all([
      import("@/plugins/cognia-scheduler-tools/plugin.json"),
      import("@/plugins/cognia-scheduler-tools/src/index"),
    ])
    const exports = schedulerModule as unknown as Record<string, unknown>

    const result = await registerBotsForPlugin(
      schedulerManifest.default as unknown as PluginManifest,
      "builtin://cognia-scheduler-tools",
      // Exactly what `importInstalledEntry` hands back for a `builtin://`
      // root: the whole module, not a path import.
      { importer: async () => exports }
    )

    expect(result.errors).toEqual([])
    expect(result.registered).toBe(1)
    const registered = getBot("cognia-scheduler-tools:schedule-digest")
    expect(typeof registered?.handler).toBe("function")
    // Not the definition object. A `{ default: definition }` fallback would
    // satisfy "is a function" for a plugin whose default export happens to be
    // callable, so the identity is what pins it.
    expect(registered?.handler).toBe(exports.scheduleDigestBot)
  })
})

describe("lifecycle hook resolution", () => {
  const lifecycleDef = (overrides: Record<string, unknown>) =>
    bot({
      id: "h",
      entry: "./bots/h.js",
      lifecycle: { hooks: ["onInstall"], ...overrides } as never,
    })

  it("resolves a JS hook from the handler entry when lifecycle.entry is absent", async () => {
    const onInstall = jest.fn()
    const importer = jest.fn().mockResolvedValue({ default: jest.fn(), onInstall })

    const result = await registerBotsForPlugin(manifest({ bots: [lifecycleDef({})] }), "/root", {
      importer,
    })

    expect(result.errors).toEqual([])
    expect(importer).toHaveBeenCalledWith(expect.stringContaining("bots/h.js"))
    expect(getBot("acme:h")?.lifecycle?.onInstall).toBe(onInstall)
  })

  it("prefers lifecycle.entry over the handler entry", async () => {
    const onArm = jest.fn()
    const importer = jest.fn(async (entry: string) =>
      entry.includes("lifecycle.js") ? { onArm } : { default: jest.fn() }
    )

    await registerBotsForPlugin(
      manifest({
        bots: [lifecycleDef({ entry: "./bots/lifecycle.js", hooks: ["onArm"] })],
      }),
      "/root",
      { importer }
    )

    expect(getBot("acme:h")?.lifecycle?.onArm).toBe(onArm)
  })

  it("fails the whole Bot when a declared hook export is missing", async () => {
    const importer = jest.fn().mockResolvedValue({ default: jest.fn() })

    const result = await registerBotsForPlugin(
      manifest({
        bots: [
          lifecycleDef({ hooks: ["onInstall", "onUninstall"] }),
          bot({ id: "good", entry: "./bots/good.js" }),
        ],
      }),
      "/root",
      { importer }
    )

    // No half-Bot: the definition must not register without its hooks.
    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain('"onInstall"')
    expect(listBotIds()).toEqual(["acme:good"])
  })

  it("fails a non-handler executor whose lifecycle declares no entry", async () => {
    const result = await registerBotsForPlugin(
      manifest({
        bots: [
          bot({
            id: "wf",
            executor: "workflow",
            workflow: "wf_1",
            lifecycle: { hooks: ["onInstall"] },
          } as never),
        ],
      }),
      "/root",
      { importer: jest.fn() }
    )

    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toContain(
      'JS-backed bot "wf" declares lifecycle hooks but no entry to load them from'
    )
    expect(getBot("acme:wf")).toBeUndefined()
  })

  it("builds a python proxy per declared hook, separate from the run proxy", async () => {
    const onInstall = jest.fn().mockResolvedValue(undefined)
    const onUninstall = jest.fn().mockResolvedValue(undefined)
    mockCreateProxy
      .mockReturnValueOnce({ run: jest.fn() } as never)
      .mockReturnValueOnce({ onInstall, onUninstall } as never)

    await registerBotsForPlugin(
      manifest({
        type: "python",
        bots: [
          bot({
            id: "h",
            lifecycle: { hooks: ["onInstall", "onUninstall"] },
          } as never),
        ],
      }),
      "/root",
      { importer: jest.fn() }
    )

    expect(mockCreateProxy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ methods: ["run"], label: "Bot handler" })
    )
    expect(mockCreateProxy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pluginId: "acme",
        contributionId: "h",
        methods: ["onInstall", "onUninstall"],
        label: "Bot lifecycle",
      })
    )
    const lifecycle = getBot("acme:h")?.lifecycle
    const ctx = { installation: { id: "boti_1" } }
    await lifecycle?.onInstall?.(ctx as never)
    expect(onInstall).toHaveBeenCalledWith(ctx)
    await lifecycle?.onUninstall?.(ctx as never)
    expect(onUninstall).toHaveBeenCalledWith(ctx)
  })

  it("leaves lifecycle undefined when the definition declares none", async () => {
    const importer = jest.fn().mockResolvedValue({ default: jest.fn() })
    await registerBotsForPlugin(manifest({ bots: [bot({ id: "h", entry: "./h.js" })] }), "/root", {
      importer,
    })
    expect(getBot("acme:h")?.lifecycle).toBeUndefined()
  })
})
