import {
  BRIDGE_ROUTE_TICKET_PATH,
  BRIDGE_ROUTE_TICKET_REVOKE_PATH,
  RPC_ROUTE_TICKET_REVOKE_COMMAND,
  describeMintFailure,
  revokeRouteTicket,
  mintRouteTicket,
  mintRouteTicketViaBridge,
  mintRouteTicketViaRpc,
} from "./mint-ticket"

const request = {
  model: "claude-opus-5",
  sessionId: "x-claude-1",
  executionFingerprint: "aexf1-x",
  routePolicy: "gateway-required",
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("mintRouteTicketViaBridge", () => {
  it("posts to the bridge with the dev token and returns the one-shot secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const outcome = await mintRouteTicketViaBridge(request, {
      detect: async () => ({ baseUrl: "http://127.0.0.1:4242", devToken: "tok" }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return jsonResponse(200, {
          ok: true,
          endpoint: "http://127.0.0.1:47823/v1",
          ticket: { ticketId: "rt_1", modelBindings: { haiku: "h" }, expiresAtMs: 99 },
          secret: "sk-cognia-rt-abc",
        })
      },
    })
    expect(outcome).toEqual({
      ok: true,
      via: "bridge",
      ticket: {
        endpoint: "http://127.0.0.1:47823/v1",
        ticketId: "rt_1",
        secret: "sk-cognia-rt-abc",
        modelBindings: { haiku: "h" },
        expiresAtMs: 99,
      },
    })
    expect(calls[0]!.url).toBe(`http://127.0.0.1:4242${BRIDGE_ROUTE_TICKET_PATH}`)
    expect((calls[0]!.init.headers as Record<string, string>)["X-Cognia-Dev-Token"]).toBe("tok")
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: "claude-opus-5" })
  })

  it("reports no desktop, rejections, and an old desktop without the route", async () => {
    expect(await mintRouteTicketViaBridge(request, { detect: async () => null })).toMatchObject({
      ok: false,
      reason: "no-desktop",
    })
    const rejected = await mintRouteTicketViaBridge(request, {
      detect: async () => ({ baseUrl: "http://127.0.0.1:1", devToken: "t" }),
      fetch: async () =>
        jsonResponse(503, { ok: false, error: "gateway has no routing snapshot yet" }),
    })
    expect(rejected).toMatchObject({ ok: false, reason: "rejected", message: /snapshot/ })
    const old = await mintRouteTicketViaBridge(request, {
      detect: async () => ({ baseUrl: "http://127.0.0.1:1", devToken: "t" }),
      fetch: async () => new Response("not found", { status: 404 }),
    })
    expect(old).toMatchObject({ ok: false, reason: "unavailable" })
  })
})

describe("mintRouteTicketViaRpc", () => {
  it("needs both server url and service token", async () => {
    expect(await mintRouteTicketViaRpc(request, { env: {} })).toMatchObject({
      ok: false,
      via: "rpc",
      reason: "no-server",
    })
  })

  it("posts to /internal/_rpc with the service token and maps unknown_command to unavailable", async () => {
    const seen: string[] = []
    const ok = await mintRouteTicketViaRpc(request, {
      env: { COGNIA_SERVER_URL: "https://host:9/", COGNIA_SERVICE_TOKEN: "svc" },
      fetch: async (url, init) => {
        seen.push(String(url), (init!.headers as Record<string, string>).authorization)
        return jsonResponse(200, {
          gatewayPort: 47823,
          ticket: { ticketId: "rt_2", modelBindings: {}, expiresAtMs: 1 },
          secret: "sk-cognia-rt-def",
        })
      },
    })
    expect(seen).toEqual(["https://host:9/internal/_rpc/gateway_mint_route_ticket", "Bearer svc"])
    expect(ok).toMatchObject({
      ok: true,
      via: "rpc",
      ticket: { endpoint: "http://127.0.0.1:47823/v1" },
    })

    const missing = await mintRouteTicketViaRpc(request, {
      env: { COGNIA_SERVER_URL: "https://host:9", COGNIA_SERVICE_TOKEN: "svc" },
      fetch: async () => jsonResponse(404, { code: "unknown_command", message: "not registered" }),
    })
    expect(missing).toMatchObject({ ok: false, reason: "unavailable" })
  })
})

describe("mintRouteTicket", () => {
  it("tries the bridge, then the rpc, and describes every failed leg", async () => {
    const result = await mintRouteTicket(request, {
      detect: async () => null,
      env: {},
    })
    expect(result.outcome.ok).toBe(false)
    expect(result.attempts.map((a) => a.via)).toEqual(["bridge", "rpc"])
    const hint = describeMintFailure(result.attempts)
    expect(hint).toContain("bridge: the Cognia desktop app is not running")
    expect(hint).toContain("rpc: no headless server configured")
  })
})

describe("revokeRouteTicket", () => {
  it("posts the ticket id to the bridge revoke route with the dev token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const outcome = await revokeRouteTicket("rt_1", "bridge", {
      detect: async () => ({ baseUrl: "http://127.0.0.1:4242", devToken: "tok" }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return jsonResponse(200, { ok: true, ticketId: "rt_1", revoked: true })
      },
    })
    expect(outcome).toEqual({ ok: true, via: "bridge", revoked: true })
    expect(calls[0]!.url).toBe(`http://127.0.0.1:4242${BRIDGE_ROUTE_TICKET_REVOKE_PATH}`)
    expect((calls[0]!.init.headers as Record<string, string>)["X-Cognia-Dev-Token"]).toBe("tok")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ticketId: "rt_1" })
  })

  it("reports a bridge that vanished or lacks the route, without throwing", async () => {
    await expect(
      revokeRouteTicket("rt_1", "bridge", { detect: async () => null })
    ).resolves.toMatchObject({ ok: false, via: "bridge", reason: "no-desktop" })
    await expect(
      revokeRouteTicket("rt_1", "bridge", {
        detect: async () => ({ baseUrl: "http://127.0.0.1:4242", devToken: "tok" }),
        fetch: async () => jsonResponse(404, { error: "no such route" }),
      })
    ).resolves.toMatchObject({ ok: false, via: "bridge", reason: "unavailable" })
    await expect(
      revokeRouteTicket("rt_1", "bridge", {
        detect: async () => ({ baseUrl: "http://127.0.0.1:4242", devToken: "tok" }),
        fetch: async () => {
          throw new Error("ECONNRESET")
        },
      })
    ).resolves.toMatchObject({ ok: false, via: "bridge", reason: "network" })
  })

  it("calls the headless rpc arm with the service token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const outcome = await revokeRouteTicket("rt_2", "rpc", {
      env: { COGNIA_SERVER_URL: "http://srv:8080/", COGNIA_SERVICE_TOKEN: "svc" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return jsonResponse(200, { ticketId: "rt_2", revoked: false })
      },
    })
    expect(outcome).toEqual({ ok: true, via: "rpc", revoked: false })
    expect(calls[0]!.url).toBe(`http://srv:8080/internal/_rpc/${RPC_ROUTE_TICKET_REVOKE_COMMAND}`)
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer svc")
    await expect(revokeRouteTicket("rt_2", "rpc", { env: {} })).resolves.toMatchObject({
      ok: false,
      reason: "no-server",
    })
  })
})
