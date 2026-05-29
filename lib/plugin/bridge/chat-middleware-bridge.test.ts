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

const passthrough: ChatMiddleware = (req, next) => next()

function manifest(chatMiddlewares: PluginManifest["chatMiddlewares"]): PluginManifest {
  return { id: "demo", chatMiddlewares } as PluginManifest
}

beforeEach(() => {
  __resetChatMiddlewareRegistryForTesting()
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
