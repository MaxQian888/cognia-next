import {
  getTunnelConfig,
  parseTunnelBusy,
  probeTunnel,
  saveNamedTunnelConfig,
  setTunnelMode,
  startTunnel,
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

describe("startTunnel", () => {
  it("passes the replace flag through and reports a started tunnel", async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const loader: () => Promise<TauriInvoker | null> = async () => ({
      async invoke<T>(_cmd: string, args?: Record<string, unknown>): Promise<T> {
        seen.push(args)
        return { publicUrl: "https://a.trycloudflare.com", localUrl: "l" } as T
      },
    })
    const result = await startTunnel("https://127.0.0.1:27890", loader, { replace: true })
    expect(result.kind).toBe("started")
    expect(seen[0]).toEqual({ localUrl: "https://127.0.0.1:27890", replace: true })
    await startTunnel("https://127.0.0.1:27890", loader)
    expect(seen[1]).toEqual({ localUrl: "https://127.0.0.1:27890", replace: false })
  })

  it("reads the Rust tunnel_busy error into a busy outcome with the current origin", async () => {
    const loader: () => Promise<TauriInvoker | null> = async () => ({
      async invoke<T>(): Promise<T> {
        throw new Error(
          "tunnel_busy: already exposing http://127.0.0.1:7891 at https://a.trycloudflare.com"
        )
      },
    })
    expect(await startTunnel("https://127.0.0.1:27890", loader)).toEqual({
      kind: "busy",
      current: { localUrl: "http://127.0.0.1:7891", publicUrl: "https://a.trycloudflare.com" },
    })
  })

  it("still reads the not-installed message and everything else as error", async () => {
    const notInstalled: () => Promise<TauriInvoker | null> = async () => ({
      async invoke<T>(): Promise<T> {
        throw new Error("cloudflared not found in PATH (install: https://x)")
      },
    })
    expect((await startTunnel("l", notInstalled)).kind).toBe("not_installed")
    expect((await startTunnel("l", failingInvoker())).kind).toBe("error")
    expect((await startTunnel("l", nullInvoker())).kind).toBe("unsupported")
  })
})

describe("parseTunnelBusy", () => {
  it("only matches the exact busy shape", () => {
    expect(parseTunnelBusy("tunnel_busy: already exposing a at b")).toEqual({
      localUrl: "a",
      publicUrl: "b",
    })
    expect(parseTunnelBusy("timed out waiting for tunnel URL")).toBeNull()
    expect(parseTunnelBusy("")).toBeNull()
  })
})

describe("probeTunnel", () => {
  it("returns the probe, and null off the desktop or on failure", async () => {
    const probe = {
      installed: true,
      path: "/opt/homebrew/bin/cloudflared",
      version: "cloudflared version 2026.8.1",
    }
    expect(await probeTunnel(makeInvoker({ companion_tunnel_probe: probe }))).toEqual(probe)
    expect(await probeTunnel(nullInvoker())).toBeNull()
    expect(await probeTunnel(failingInvoker())).toBeNull()
  })
})
