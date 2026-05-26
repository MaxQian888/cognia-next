import {
  getTunnelConfig,
  saveNamedTunnelConfig,
  setTunnelMode,
  type TauriInvoker,
} from "./tunnel-resolver"

function makeInvoker(responses: Record<string, unknown>): () => Promise<TauriInvoker | null> {
  return async () => ({
    async invoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
      if (cmd in responses) {
        return Promise.resolve(responses[cmd] as T)
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`))
    },
  })
}

function failingInvoker(): () => Promise<TauriInvoker | null> {
  return async () => ({
    async invoke<T>(_cmd: string, _args?: Record<string, unknown>): Promise<T> {
      return Promise.reject(new Error("tauri error"))
    },
  })
}

function nullInvoker(): () => Promise<TauriInvoker | null> {
  return async () => null
}

describe("getTunnelConfig", () => {
  it("returns config when tauri is available", async () => {
    const cfg = { mode: "named" as const, hostname: "https://c.example.com", hasToken: true }
    const result = await getTunnelConfig(makeInvoker({ companion_tunnel_get_config: cfg }))
    expect(result).toEqual(cfg)
  })

  it("returns null when invoker is null", async () => {
    const result = await getTunnelConfig(nullInvoker())
    expect(result).toBeNull()
  })

  it("returns null on tauri error", async () => {
    const result = await getTunnelConfig(failingInvoker())
    expect(result).toBeNull()
  })
})

describe("saveNamedTunnelConfig", () => {
  it("succeeds when tauri responds", async () => {
    const result = await saveNamedTunnelConfig(
      "tok",
      "https://c.example.com",
      makeInvoker({ companion_tunnel_save_named_config: undefined })
    )
    expect(result).toEqual({ kind: "ok" })
  })

  it("returns unsupported when invoker is null", async () => {
    const result = await saveNamedTunnelConfig("tok", "host", nullInvoker())
    expect(result).toEqual({ kind: "error", message: "Tauri not available" })
  })

  it("returns error on tauri failure", async () => {
    const result = await saveNamedTunnelConfig("tok", "host", failingInvoker())
    expect(result.kind).toBe("error")
    expect(result).toMatchObject({ kind: "error", message: "tauri error" })
  })
})

describe("setTunnelMode", () => {
  it("succeeds when tauri responds", async () => {
    const result = await setTunnelMode(
      "named",
      makeInvoker({ companion_tunnel_set_mode: undefined })
    )
    expect(result).toEqual({ kind: "ok" })
  })

  it("returns unsupported when invoker is null", async () => {
    const result = await setTunnelMode("quick", nullInvoker())
    expect(result).toEqual({ kind: "error", message: "Tauri not available" })
  })
})
