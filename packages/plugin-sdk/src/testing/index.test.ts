import { PLUGIN_API_NAMESPACE_CONTRACTS } from "../contracts/catalog"
import { createTestPluginContext } from "./index"

describe("createTestPluginContext", () => {
  it("mounts every namespace and method the contract catalog lists", () => {
    const { ctx } = createTestPluginContext()
    const surface = ctx as unknown as Record<string, unknown>
    const missing = PLUGIN_API_NAMESPACE_CONTRACTS.flatMap((namespace) =>
      namespace.methods
        .filter((method) => {
          const target = method.name
            .split(".")
            .reduce<unknown>(
              (holder, segment) => (holder as Record<string, unknown> | undefined)?.[segment],
              surface[namespace.id]
            )
          return typeof target !== "function"
        })
        .map((method) => method.id)
    )
    expect(missing).toEqual([])
  })

  it("records calls and hands registrations a disposer", () => {
    const { ctx, callsTo } = createTestPluginContext({ pluginId: "acme" })
    const dispose = ctx.agent.registerTool({
      name: "acme_echo",
      definition: { name: "acme_echo", description: "Echo", parametersSchema: {} },
      execute: async () => ({ ok: true }),
    })
    expect(typeof dispose).toBe("function")
    expect(callsTo("agent.registerTool")).toHaveLength(1)
    expect(ctx.pluginId).toBe("acme")
  })

  it("interpolates i18n params and reports the chosen locale", () => {
    const { ctx } = createTestPluginContext({ locale: "zh-CN" })
    expect(ctx.i18n.t("card.title {city}", { city: "Oslo" })).toBe("card.title Oslo")
    expect(ctx.i18n.getCurrentLocale()).toBe("zh-CN")
  })

  it("keeps storage and secrets in memory", async () => {
    const { ctx } = createTestPluginContext()
    await ctx.storage.set("buffer", [1, 2])
    await expect(ctx.storage.get("buffer")).resolves.toEqual([1, 2])
    await ctx.secrets.store("token", "s3cret")
    await expect(ctx.secrets.get("token")).resolves.toBe("s3cret")
  })

  it("reports the requested shell through capabilities", () => {
    expect(createTestPluginContext({ platform: "mobile" }).ctx.capabilities).toMatchObject({
      tauri: false,
      mobile: true,
      platform: "mobile",
    })
  })

  it("merges overrides per namespace and runs lifecycle disposers on dispose", async () => {
    const readText = jest.fn(async () => "copied")
    const test = createTestPluginContext({ overrides: { clipboard: { readText } } })
    await expect(test.ctx.clipboard.readText()).resolves.toBe("copied")
    expect(typeof test.ctx.clipboard.writeText).toBe("function")

    const order: string[] = []
    test.ctx.lifecycle.onDispose(() => void order.push("first"))
    test.ctx.lifecycle.onDispose(() => void order.push("second"))
    await test.dispose()
    expect(order).toEqual(["second", "first"])
    expect(test.ctx.lifecycle.signal.aborted).toBe(true)
  })
})
