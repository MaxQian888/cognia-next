/**
 * @jest-environment node
 */
import net from "node:net"
import { proxyToHost, proxyToRenderer, __testing__ } from "./orchestration-proxy-client"

/** Boot a tiny newline-JSON echo server that answers each request by `id`. */
async function startEchoServer(
  reply: (req: { id: string; command: string; args: unknown }) => Record<string, unknown>
): Promise<{ addr: string; close: () => void }> {
  const server = net.createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let nl = buffer.indexOf("\n")
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line) {
          const req = JSON.parse(line)
          const resp = { id: req.id, ...reply(req) }
          socket.write(JSON.stringify(resp) + "\n")
        }
        nl = buffer.indexOf("\n")
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as net.AddressInfo
  return {
    addr: `127.0.0.1:${address.port}`,
    close: () => server.close(),
  }
}

const ORIG = { ...process.env }

afterEach(() => {
  __testing__.resetProxyClient()
  process.env.COGNIA_ORCH_PROXY = ORIG.COGNIA_ORCH_PROXY
  process.env.COGNIA_ORCH_PROXY_TOKEN = ORIG.COGNIA_ORCH_PROXY_TOKEN
})

describe("proxyToRenderer", () => {
  it("returns a desktop-required error when the proxy env is unset", async () => {
    delete process.env.COGNIA_ORCH_PROXY
    delete process.env.COGNIA_ORCH_PROXY_TOKEN
    const out = await proxyToRenderer<{ ok: boolean; error?: string }>("agent_dispatch", {})
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/desktop renderer/)
  })

  it("forwards the command + args and returns the renderer result by id", async () => {
    const seen: Array<{ command: string; args: unknown }> = []
    const srv = await startEchoServer((req) => {
      seen.push({ command: req.command, args: req.args })
      return { ok: true, result: { ok: true, text: "hello", redacted: true } }
    })
    process.env.COGNIA_ORCH_PROXY = srv.addr
    process.env.COGNIA_ORCH_PROXY_TOKEN = "tok"
    try {
      const out = await proxyToRenderer<{ ok: boolean; text?: string; redacted?: boolean }>(
        "agent_dispatch",
        { prompt: "hi", subagentId: "r" }
      )
      expect(out).toMatchObject({ ok: true, text: "hello", redacted: true })
      expect(seen[0]).toMatchObject({
        command: "agent_dispatch",
        args: { prompt: "hi", subagentId: "r" },
      })
    } finally {
      srv.close()
    }
  })

  it("surfaces a proxy-level failure as ok:false", async () => {
    const srv = await startEchoServer(() => ({ ok: false, error: "scope denied" }))
    process.env.COGNIA_ORCH_PROXY = srv.addr
    process.env.COGNIA_ORCH_PROXY_TOKEN = "tok"
    try {
      const out = await proxyToRenderer<{ ok: boolean; error?: string }>("team_run", {})
      expect(out).toEqual({ ok: false, error: "scope denied" })
    } finally {
      srv.close()
    }
  })

  it("returns an error for a malformed proxy address", async () => {
    process.env.COGNIA_ORCH_PROXY = "not-a-host-port"
    process.env.COGNIA_ORCH_PROXY_TOKEN = "tok"
    const out = await proxyToRenderer<{ ok: boolean; error?: string }>("agent_dispatch", {})
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/invalid COGNIA_ORCH_PROXY/)
  })
})

describe("proxyToHost", () => {
  it("returns arbitrary canonical handler values", async () => {
    const srv = await startEchoServer(() => ({ ok: true, result: ["one", "two"] }))
    process.env.COGNIA_ORCH_PROXY = srv.addr
    process.env.COGNIA_ORCH_PROXY_TOKEN = "tok"
    try {
      await expect(proxyToHost<string[]>("listSkills", { arguments: [] })).resolves.toEqual([
        "one",
        "two",
      ])
    } finally {
      srv.close()
    }
  })

  it("rejects proxy-level failures for non-envelope handlers", async () => {
    const srv = await startEchoServer(() => ({ ok: false, error: "host unavailable" }))
    process.env.COGNIA_ORCH_PROXY = srv.addr
    process.env.COGNIA_ORCH_PROXY_TOKEN = "tok"
    try {
      await expect(proxyToHost("wikiSearch", { arguments: [] })).rejects.toThrow("host unavailable")
    } finally {
      srv.close()
    }
  })
})
