import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"
import type { BotRunContextV1 } from "@/types/bot/run"

import { createPythonBackedProxy } from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { __resetBotsForTesting, getBot, listBotIds } from "@/lib/plugin/registries/bot-registry"

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
