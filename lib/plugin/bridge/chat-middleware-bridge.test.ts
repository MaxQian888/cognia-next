import {
  registerChatMiddlewaresForPlugin,
  unregisterChatMiddlewaresForPlugin,
} from "./chat-middleware-bridge"
import {
  listAllChatMiddlewares,
  __resetChatMiddlewareRegistryForTesting,
} from "@/lib/claude/chat-middleware/registry"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"
import { createPythonBackedProxy } from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import {
  __resetExperimentalPythonFlagForTesting,
  setExperimentalPythonBackedEnabled,
} from "@/lib/plugin/python/experimental-flag"

jest.mock("@/lib/plugin/bridge/_shared/python-backed-proxy", () => ({
  ...jest.requireActual("@/lib/plugin/bridge/_shared/python-backed-proxy"),
  createPythonBackedProxy: jest.fn(),
}))

const mockCreateProxy = createPythonBackedProxy as jest.MockedFunction<
  typeof createPythonBackedProxy
>

const passthrough: ChatMiddleware = (req, next) => next()

function manifest(chatMiddlewares: PluginManifest["chatMiddlewares"]): PluginManifest {
  return { id: "demo", chatMiddlewares } as PluginManifest
}

beforeEach(() => {
  __resetChatMiddlewareRegistryForTesting()
})

describe("chat-middleware-bridge python backend", () => {
  const pythonManifest = (defs: PluginManifest["chatMiddlewares"]): PluginManifest =>
    ({ id: "demo", type: "python", pythonMain: "main.py", chatMiddlewares: defs }) as PluginManifest

  beforeEach(() => {
    mockCreateProxy.mockReset()
    // chat-middleware is `pythonExecution: "experimental"`, so the gate must be
    // opened explicitly — the shipped default is off.
    setExperimentalPythonBackedEnabled(true)
  })

  afterEach(() => {
    __resetExperimentalPythonFlagForTesting()
  })

  it("skips registration entirely while the experimental flag is off", async () => {
    __resetExperimentalPythonFlagForTesting()
    stub(null, null)
    await registerChatMiddlewaresForPlugin(pythonManifest([{ id: "py", label: "Py" }]), "/root", {
      importer: jest.fn(),
    })
    expect(listAllChatMiddlewares()).toHaveLength(0)
  })

  function stub(before: unknown, after: unknown) {
    mockCreateProxy.mockReturnValue({
      before: jest.fn().mockResolvedValue(before),
      after: jest.fn().mockResolvedValue(after),
    } as never)
  }

  it("registers a python-backed middleware with no entry/export", async () => {
    stub(null, null)
    const importer = jest.fn()
    await registerChatMiddlewaresForPlugin(pythonManifest([{ id: "py", label: "Py" }]), "/root", {
      importer,
    })

    expect(importer).not.toHaveBeenCalled()
    expect(listAllChatMiddlewares().map((m) => m.middlewareId)).toEqual(["py"])
  })

  it("synthesizes around-semantics from before/after", async () => {
    stub({ request: { model: "swapped" } }, { text: "after" })
    await registerChatMiddlewaresForPlugin(pythonManifest([{ id: "py", label: "Py" }]), "/root", {
      importer: jest.fn(),
    })

    const fn = listAllChatMiddlewares()[0]!.fn
    const next = jest.fn().mockResolvedValue({ text: "from-chain" })
    const out = await fn({ model: "original" } as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    // `after`'s return replaces the chain response.
    expect(out).toEqual({ text: "after" })
  })

  it("short-circuits the chain when before returns shortCircuit", async () => {
    stub({ shortCircuit: { text: "blocked" } }, null)
    await registerChatMiddlewaresForPlugin(pythonManifest([{ id: "py", label: "Py" }]), "/root", {
      importer: jest.fn(),
    })

    const fn = listAllChatMiddlewares()[0]!.fn
    const next = jest.fn()
    const out = await fn({ model: "m" } as never, next)

    expect(next).not.toHaveBeenCalled()
    expect(out).toEqual({ text: "blocked" })
  })

  it("falls back to the chain response when after returns null", async () => {
    stub(null, null)
    await registerChatMiddlewaresForPlugin(pythonManifest([{ id: "py", label: "Py" }]), "/root", {
      importer: jest.fn(),
    })

    const fn = listAllChatMiddlewares()[0]!.fn
    const out = await fn({ model: "m" } as never, jest.fn().mockResolvedValue({ text: "chain" }))
    expect(out).toEqual({ text: "chain" })
  })
})

describe("chat-middleware-bridge", () => {
  it("registers a middleware from the manifest with priority + timeout", async () => {
    await registerChatMiddlewaresForPlugin(
      manifest([
        {
          id: "logger",
          label: "Logger",
          entry: "dist/mw.js",
          export: "mw",
          priority: 5,
          timeoutMs: 2000,
        },
      ]),
      "/p/demo",
      { importer: async () => ({ mw: passthrough }) }
    )
    const all = listAllChatMiddlewares()
    expect(all).toHaveLength(1)
    expect(all[0].fullId).toBe("demo:logger")
    expect(all[0].priority).toBe(5)
    expect(all[0].timeoutMs).toBe(2000)
  })

  it("skips an export that is not a function", async () => {
    await registerChatMiddlewaresForPlugin(
      manifest([{ id: "bad", label: "Bad", entry: "dist/mw.js", export: "nope" }]),
      "/p/demo",
      { importer: async () => ({ mw: passthrough }) }
    )
    expect(listAllChatMiddlewares()).toHaveLength(0)
  })

  it("never throws when an entry import fails", async () => {
    await expect(
      registerChatMiddlewaresForPlugin(
        manifest([{ id: "boom", label: "Boom", entry: "dist/mw.js", export: "mw" }]),
        "/p/demo",
        {
          importer: async () => {
            throw new Error("import failed")
          },
        }
      )
    ).resolves.toBeUndefined()
    expect(listAllChatMiddlewares()).toHaveLength(0)
  })

  it("skips malformed entries (missing id/entry/export)", async () => {
    await registerChatMiddlewaresForPlugin(
      manifest([{ id: "", label: "x", entry: "", export: "" } as never]),
      "/p/demo",
      { importer: async () => ({ mw: passthrough }) }
    )
    expect(listAllChatMiddlewares()).toHaveLength(0)
  })

  it("unregister drops every middleware owned by the plugin", async () => {
    await registerChatMiddlewaresForPlugin(
      manifest([{ id: "logger", label: "Logger", entry: "dist/mw.js", export: "mw" }]),
      "/p/demo",
      { importer: async () => ({ mw: passthrough }) }
    )
    unregisterChatMiddlewaresForPlugin("demo")
    expect(listAllChatMiddlewares()).toHaveLength(0)
  })
})
