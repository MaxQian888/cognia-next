import type { PluginContext, PluginHooksAll, ShareLinkHookPayload } from "@cognia/plugin-sdk"

import definition, { createShareWatchHooks, manifest, SHARE_WATCH_EXAMPLE } from "./index"
import manifestJson from "../plugin.json"

const link = (over: Partial<ShareLinkHookPayload> = {}): ShareLinkHookPayload => ({
  code: "AbC",
  kind: "chat-html",
  title: "Greeting",
  url: "https://share.test/share/view?c=AbC",
  ...over,
})

function makeCtx() {
  const info = jest.fn()
  const ctx = { pluginId: manifestJson.id, logger: { info } } as unknown as PluginContext
  return { ctx, info }
}

describe("cognia-share-watch (example)", () => {
  it("returns share hooks from activate()", async () => {
    const { ctx } = makeCtx()
    const hooks = (await definition.activate?.(ctx)) as PluginHooksAll
    expect(hooks.onShareLinkCreate).toBeInstanceOf(Function)
    expect(hooks.onShareLinkRevoke).toBeInstanceOf(Function)
  })

  it("logs create + revoke with the fragment-free url only", async () => {
    const { ctx, info } = makeCtx()
    const hooks = createShareWatchHooks(ctx.logger)
    await hooks.onShareLinkCreate?.(link({ code: "X1", url: "https://share.test/share/view?c=X1" }))
    await hooks.onShareLinkRevoke?.("X1")

    expect(info.mock.calls.map((call) => call[0])).toEqual([
      "share link created: X1 (chat-html) https://share.test/share/view?c=X1",
      "share link revoked: X1",
    ])
  })

  it("strips a key fragment even if one ever reaches the hook", async () => {
    const { ctx, info } = makeCtx()
    const hooks = createShareWatchHooks(ctx.logger)
    await hooks.onShareLinkCreate?.(link({ url: "https://share.test/share/view?c=AbC#k=secret" }))
    expect(info.mock.calls[0][0]).not.toContain("#k=")
    expect(info.mock.calls[0][0]).not.toContain("secret")
  })

  // Rule 7: documented at the const, labelled in the UI, pinned here.
  it("is labelled and gated as an opt-in example with no UI surface", () => {
    expect(SHARE_WATCH_EXAMPLE).toEqual({ example: true, surface: "plugin-log" })
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifest.activationEvents ?? []).not.toContain("startup")
    expect(manifestJson.name).toContain("(example)")
    expect(manifestJson.description).toMatch(/adds no UI/)
    expect(manifest.extensions ?? []).toEqual([])
  })
})
