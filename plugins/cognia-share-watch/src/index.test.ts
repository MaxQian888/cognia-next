import definition, { getShareWatchLog, __resetShareWatchForTesting } from "./index"
import manifest from "../plugin.json"
import type { PluginHooksAll, ShareLinkHookPayload } from "@/types/plugin/plugin-hooks"

const link = (over: Partial<ShareLinkHookPayload> = {}): ShareLinkHookPayload => ({
  code: "AbC",
  kind: "chat-html",
  title: "Greeting",
  url: "https://share.test/share/view?c=AbC",
  ...over,
})

const ctx = () => ({ pluginId: manifest.id, logger: { info: jest.fn() } }) as never

beforeEach(() => {
  __resetShareWatchForTesting()
})

describe("cognia-share-watch", () => {
  it("declares the hooks capability and returns share hooks from activate()", async () => {
    expect(manifest.capabilities).toContain("hooks")
    const hooks = (await definition.activate?.(ctx())) as PluginHooksAll
    expect(hooks?.onShareLinkCreate).toBeInstanceOf(Function)
    expect(hooks?.onShareLinkRevoke).toBeInstanceOf(Function)
  })

  it("records create + revoke, keeping only the fragment-stripped url", async () => {
    const hooks = (await definition.activate?.(ctx())) as PluginHooksAll
    await hooks.onShareLinkCreate?.(link({ code: "X1", url: "https://share.test/share/view?c=X1" }))
    await hooks.onShareLinkRevoke?.("X1")

    const entries = getShareWatchLog()
    expect(entries).toEqual([
      { kind: "created", code: "X1", url: "https://share.test/share/view?c=X1" },
      { kind: "revoked", code: "X1" },
    ])
    expect(entries[0].url).not.toContain("#k=")
  })
})
