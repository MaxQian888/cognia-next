import type { PluginContext } from "@/types/plugin"
import type { AiBridge } from "./lib/ai"
import { buildEngineDeps, getAiBridge, networkFetch } from "./runtime"

const ai: AiBridge = { chat: async function* () {}, embed: async () => [] }

function ctx(over: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    config: {},
    logger: { info() {}, warn() {} },
    ...over,
  } as unknown as PluginContext
}

describe("getAiBridge", () => {
  it("returns the bridge when chat + embed are functions", () => {
    expect(getAiBridge(ctx({ ai }))).toBe(ai)
  })
  it("returns null when ai is missing or malformed", () => {
    expect(getAiBridge(ctx())).toBeNull()
    expect(getAiBridge(ctx({ ai: { chat: 1, embed: 2 } }))).toBeNull()
  })
})

describe("buildEngineDeps", () => {
  it("errors NO_PROVIDER when there is no model bridge", async () => {
    const res = await buildEngineDeps(ctx())
    expect(res).toMatchObject({ ok: false, error: "NO_PROVIDER" })
  })

  it("errors MISSING_KEY when no api key is configured", async () => {
    const res = await buildEngineDeps(ctx({ ai }))
    expect(res).toMatchObject({ ok: false, error: "MISSING_KEY", provider: "exa" })
  })

  it("builds deps when ai + key are present", async () => {
    const res = await buildEngineDeps(
      ctx({ ai, config: { exaApiKey: "k" }, secrets: { get: async () => null } })
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deps.ai).toBe(ai)
      expect(typeof res.deps.search).toBe("function")
      expect(typeof res.deps.read).toBe("function")
    }
  })

  it("threads reportProgress + signal into the deps", async () => {
    const reportProgress = jest.fn()
    const signal = new AbortController().signal
    const res = await buildEngineDeps(ctx({ ai, config: { exaApiKey: "k" } }), {
      reportProgress,
      signal,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deps.reportProgress).toBe(reportProgress)
      expect(res.deps.signal).toBe(signal)
    }
  })
})

describe("AI permission gate", () => {
  // `ai:chat` / `ai:embed` are PluginAPIPermissions — absent from both the
  // PluginPermission union and the SDK contract catalog, so they CANNOT be
  // declared in plugin.json. `createApiGuardedAPI` fails closed, and the only
  // free grants are notification:show + theme:read. Without an explicit
  // request every research run died on a raw PermissionError at the first
  // model call. The old fixture (a bare `{ ai }` object with no `permissions`)
  // was structurally unable to observe that — hence these cases.
  const permissionsApi = (granted: string[], onRequest: (p: string) => boolean) => {
    const set = new Set(granted)
    return {
      hasPermission: (p: string) => set.has(p),
      requestPermission: jest.fn(async (p: string, _reason?: string) => {
        const ok = onRequest(p)
        if (ok) set.add(p)
        return ok
      }),
    }
  }

  const withKey = { config: { exaApiKey: "k" }, secrets: { get: async () => null } }

  it("requests both AI permissions when neither is granted", async () => {
    const permissions = permissionsApi([], () => true)
    const res = await buildEngineDeps(ctx({ ai, permissions, ...withKey }))
    expect(res.ok).toBe(true)
    expect(permissions.requestPermission).toHaveBeenCalledTimes(2)
    expect(permissions.requestPermission.mock.calls.map((c) => c[0])).toEqual([
      "ai:chat",
      "ai:embed",
    ])
    // The prompt must explain WHY, not just name the permission.
    expect(String(permissions.requestPermission.mock.calls[0][1])).toContain("research loop")
  })

  it("does not re-request an already granted permission", async () => {
    const permissions = permissionsApi(["ai:chat", "ai:embed"], () => true)
    const res = await buildEngineDeps(ctx({ ai, permissions, ...withKey }))
    expect(res.ok).toBe(true)
    expect(permissions.requestPermission).not.toHaveBeenCalled()
  })

  it("reports NO_AI_PERMISSION when the user declines", async () => {
    const permissions = permissionsApi([], () => false)
    const res = await buildEngineDeps(ctx({ ai, permissions, ...withKey }))
    expect(res).toMatchObject({ ok: false, error: "NO_AI_PERMISSION" })
    // Stops at the first denial rather than nagging for the second.
    expect(permissions.requestPermission).toHaveBeenCalledTimes(1)
  })

  it("still requests when only one of the pair is granted", async () => {
    const permissions = permissionsApi(["ai:chat"], () => true)
    const res = await buildEngineDeps(ctx({ ai, permissions, ...withKey }))
    expect(res.ok).toBe(true)
    expect(permissions.requestPermission.mock.calls.map((c) => c[0])).toEqual(["ai:embed"])
  })

  it("does not block a host context that exposes no permission API", async () => {
    const res = await buildEngineDeps(ctx({ ai, ...withKey }))
    expect(res.ok).toBe(true)
  })
})

describe("networkFetch (CSP-safe egress)", () => {
  // `connect-src` in src-tauri/tauri.conf.json has no `https:`, so a raw
  // globalThis.fetch to api.exa.ai never leaves the renderer on desktop.
  // ctx.network routes through the Rust gateway instead.
  it("is undefined when the context exposes no network API", () => {
    expect(networkFetch(ctx())).toBeUndefined()
    expect(networkFetch(ctx({ network: {} }))).toBeUndefined()
  })

  it("forwards method/headers/body and always asks for text", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, data: '{"a":1}' }))
    const impl = networkFetch(ctx({ network: { fetch: fetchMock } }))!
    const res = await impl("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": "k" },
      body: '{"q":"x"}',
    })
    expect(fetchMock).toHaveBeenCalledWith("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": "k" },
      body: '{"q":"x"}',
      responseType: "text",
    })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ a: 1 })
    await expect(res.text()).resolves.toBe('{"a":1}')
  })

  it("tolerates a host that returns already-parsed data", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, data: { a: 1 } }))
    const impl = networkFetch(ctx({ network: { fetch: fetchMock } }))!
    const res = await impl("https://api.tavily.com/search")
    await expect(res.json()).resolves.toEqual({ a: 1 })
  })

  it("propagates a non-ok status instead of throwing", async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 401, data: "nope" }))
    const impl = networkFetch(ctx({ network: { fetch: fetchMock } }))!
    const res = await impl("https://api.exa.ai/search")
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
  })

  it("is threaded into the provider deps when the context has network", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, data: "{}" }))
    const res = await buildEngineDeps(
      ctx({
        ai,
        network: { fetch: fetchMock },
        config: { exaApiKey: "k" },
        secrets: { get: async () => null },
      })
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      await res.deps.search("q", 1).catch(() => undefined)
      // The provider went through ctx.network, not globalThis.fetch.
      expect(fetchMock).toHaveBeenCalled()
    }
  })
})
