import {
  deviceTransport,
  DEVICE_RPC_PREFIX,
  INTERNAL_RPC_PREFIX,
  classifyStatus,
  internalTransport,
  operationPath,
  withRelayFallback,
  type CommandOutcome,
  type HostTransport,
  type TransportFetch,
} from "./transport"

interface Call {
  url: string
  init: RequestInit
}

function stubFetch(
  responder: (call: Call) => { status: number; body?: unknown; text?: string }
): TransportFetch & { calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const answer = responder({ url, init })
    const text = answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body))
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => text,
    } as unknown as Response
  }) as TransportFetch & { calls: Call[] }
  impl.calls = calls
  return impl
}

const ENDPOINT = "https://127.0.0.1:27890"

describe("classifyStatus", () => {
  it("reads 404 and unknown_command as a missing command", () => {
    expect(classifyStatus(404)).toBe("unknown-command")
    expect(classifyStatus(400, "unknown_command")).toBe("unknown-command")
  })

  it("separates a credential problem from a policy refusal on 403", () => {
    expect(classifyStatus(403)).toBe("auth")
    expect(classifyStatus(403, "command_transport_forbidden")).toBe("refused")
    expect(classifyStatus(428, "interactive_approval_required")).toBe("refused")
  })

  it("reads a schema rejection as an invalid request", () => {
    expect(classifyStatus(422)).toBe("invalid-request")
    expect(classifyStatus(400)).toBe("invalid-request")
  })

  it("reads a 5xx as a failure and a gateway timeout as a timeout", () => {
    expect(classifyStatus(500)).toBe("failed")
    expect(classifyStatus(504)).toBe("timeout")
  })
})

describe("internalTransport", () => {
  it("posts to the internal RPC route with the service token", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: { ok: true } }))
    const transport = internalTransport({ endpoint: ENDPOINT, serviceToken: "svc", fetchImpl })
    const outcome = await transport.execute("plugin_list", { scope: "all" })

    expect(outcome).toMatchObject({ ok: true, result: { ok: true } })
    expect(fetchImpl.calls[0].url).toBe(`${ENDPOINT}${INTERNAL_RPC_PREFIX}/plugin_list`)
    expect(fetchImpl.calls[0].init.method).toBe("POST")
    expect((fetchImpl.calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer svc"
    )
    expect(fetchImpl.calls[0].init.body).toBe('{"scope":"all"}')
  })

  it("strips a trailing slash from the endpoint so the path never doubles", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
    await internalTransport({ endpoint: `${ENDPOINT}/`, serviceToken: "s", fetchImpl }).execute("x")
    expect(fetchImpl.calls[0].url).toBe(`${ENDPOINT}${INTERNAL_RPC_PREFIX}/x`)
  })

  it("percent-encodes the command name rather than trusting it as a path", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
    await internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl }).execute("a/../b")
    expect(fetchImpl.calls[0].url).toContain("a%2F..%2Fb")
  })

  it("sends an idempotency key only when one was supplied", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: {} }))
    const transport = internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl })
    await transport.execute("x", {}, { idempotencyKey: "key-1" })
    await transport.execute("x", {})
    expect((fetchImpl.calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "key-1"
    )
    expect(
      (fetchImpl.calls[1].init.headers as Record<string, string>)["idempotency-key"]
    ).toBeUndefined()
  })

  it("reports a 202 as accepted and carries the operation id", async () => {
    const fetchImpl = stubFetch(() => ({ status: 202, body: { operationId: "op_1" } }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("workflow_run")
    expect(outcome).toMatchObject({ ok: true, accepted: true, operationId: "op_1" })
  })

  it("carries the host's code and message into the failure", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 403,
      body: { code: "capability_denied", message: "device lacks plugin.manage", requestId: "r1" },
    }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("plugin_uninstall")
    expect(outcome).toMatchObject({
      ok: false,
      cause: "auth",
      code: "capability_denied",
      message: "device lacks plugin.manage",
      status: 403,
      requestId: "r1",
    })
  })

  it("takes the message from a problem document's detail", async () => {
    const fetchImpl = stubFetch(() => ({
      status: 410,
      body: {
        type: "https://cognia.dev/problems/command_renamed",
        title: "Gone",
        status: 410,
        detail: "session_list is now session.list",
        code: "command_renamed",
        requestId: "r2",
        retryable: false,
        details: { replacement: "session.list" },
      },
    }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("session_list")
    expect(outcome).toMatchObject({
      ok: false,
      status: 410,
      code: "command_renamed",
      message: "session_list is now session.list",
      requestId: "r2",
    })
  })

  it("keeps a non-JSON error body as a detail instead of discarding it", async () => {
    const fetchImpl = stubFetch(() => ({ status: 502, text: "<html>bad gateway</html>" }))
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x")
    expect(outcome).toMatchObject({ ok: false, cause: "failed" })
    expect((outcome as { details: string[] }).details[0]).toContain("bad gateway")
  })

  it("classifies a transport error as network without inventing a status", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as TransportFetch
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x")
    expect(outcome).toMatchObject({ ok: false, cause: "network", message: "ECONNREFUSED" })
    expect(outcome).not.toHaveProperty("status")
  })

  it("classifies an aborted request as a timeout", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted")
      error.name = "AbortError"
      throw error
    }) as TransportFetch
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x")
    expect(outcome).toMatchObject({ ok: false, cause: "timeout" })
  })

  it("aborts the request once the timeout budget elapses", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      })) as TransportFetch
    const outcome = await internalTransport({
      endpoint: ENDPOINT,
      serviceToken: "s",
      fetchImpl,
    }).execute("x", {}, { timeoutMs: 5 })
    expect(outcome).toMatchObject({ ok: false, cause: "timeout" })
  })

  it("sends an arbitrary route verbatim through request", async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: { devices: [] } }))
    await internalTransport({ endpoint: ENDPOINT, serviceToken: "s", fetchImpl }).request(
      "get",
      "/api/devices"
    )
    expect(fetchImpl.calls[0].url).toBe(`${ENDPOINT}/api/devices`)
    expect(fetchImpl.calls[0].init.method).toBe("GET")
    expect(fetchImpl.calls[0].init.body).toBeUndefined()
  })
})

describe("operationPath", () => {
  it("points at the receipt route for each wire", () => {
    expect(operationPath("internal", "op_1")).toBe("/internal/operations/op_1")
    expect(operationPath("http", "op_1")).toBe("/api/operations/op_1")
  })

  it("encodes the id rather than splicing it into the path", () => {
    expect(operationPath("internal", "a/b")).toBe("/internal/operations/a%2Fb")
  })
})

describe("device wire constants", () => {
  it("names the paired-device RPC prefix the host actually mounts", () => {
    expect(DEVICE_RPC_PREFIX).toBe("/api/_rpc")
  })
})

describe("withRelayFallback (ADR-0224 A4)", () => {
  const unreachable: CommandOutcome = { ok: false, cause: "network", message: "ECONNREFUSED" }

  function directReturning(...outcomes: CommandOutcome[]): HostTransport {
    const execute = jest.fn()
    for (const outcome of outcomes) execute.mockResolvedValueOnce(outcome)
    return {
      wire: "http",
      label: "Cognia Host (https://h:1, device d)",
      execute,
      request: jest.fn().mockResolvedValue(unreachable),
      close: jest.fn(),
    }
  }

  function relayReturning(...outcomes: CommandOutcome[]) {
    const execute = jest.fn()
    for (const outcome of outcomes) execute.mockResolvedValueOnce(outcome)
    return { execute, close: jest.fn() }
  }

  it("uses the address while it answers, and never joins the relay", async () => {
    const direct = directReturning({ ok: true, result: 1 })
    const relay = relayReturning()
    const transport = withRelayFallback(direct, relay)
    await expect(transport.execute("x")).resolves.toEqual({ ok: true, result: 1 })
    expect(relay.execute).not.toHaveBeenCalled()
    expect(transport.label).toContain("relay fallback")
  })

  it("does not fall back on a host that answered and refused", async () => {
    const refused: CommandOutcome = { ok: false, cause: "auth", message: "nope", status: 401 }
    const relay = relayReturning()
    await expect(withRelayFallback(directReturning(refused), relay).execute("x")).resolves.toBe(
      refused
    )
    expect(relay.execute).not.toHaveBeenCalled()
  })

  it("falls back when the address does not answer, then goes to the relay first", async () => {
    const direct = directReturning(unreachable)
    const relay = relayReturning({ ok: true, result: "a" }, { ok: true, result: "b" })
    const transport = withRelayFallback(direct, relay)
    await expect(transport.execute("x", { a: 1 }, { idempotencyKey: "k" })).resolves.toEqual({
      ok: true,
      result: "a",
    })
    expect(relay.execute).toHaveBeenCalledWith("x", { a: 1 }, { idempotencyKey: "k" })
    await expect(transport.execute("y")).resolves.toEqual({ ok: true, result: "b" })
    expect(direct.execute).toHaveBeenCalledTimes(1)
  })

  it("says why when neither route answers", async () => {
    const transport = withRelayFallback(
      directReturning(unreachable),
      relayReturning({ ok: false, cause: "network", message: "room did not open" })
    )
    const outcome = await transport.execute("x")
    expect(outcome).toMatchObject({
      ok: false,
      cause: "network",
      message: "the host answered neither on its address nor through its relay room",
      details: ["direct: ECONNREFUSED", "relay: room did not open"],
    })
  })

  it("goes back to the address when the relay stops answering", async () => {
    const direct = directReturning(unreachable, { ok: true, result: "direct" })
    const relay = relayReturning({ ok: true, result: "relay" }, unreachable)
    const transport = withRelayFallback(direct, relay)
    await transport.execute("x")
    await expect(transport.execute("y")).resolves.toEqual({ ok: true, result: "direct" })
  })

  it("keeps raw routes direct and says they have no relay form", async () => {
    const direct = directReturning()
    const transport = withRelayFallback(direct, relayReturning())
    const outcome = await transport.request("GET", "/api/devices")
    expect(outcome).toMatchObject({ ok: false, cause: "network" })
    expect(!outcome.ok && outcome.details?.join(" ")).toContain("no relay form")
  })

  it("closes both routes", () => {
    const direct = directReturning()
    const relay = relayReturning()
    withRelayFallback(direct, relay).close?.()
    expect(direct.close).toHaveBeenCalled()
    expect(relay.close).toHaveBeenCalled()
  })
})

describe("deviceTransport token exchange failures", () => {
  let privateKeyJwk: JsonWebKey
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
    privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  })

  /**
   * ADR-0224 A4. The token exchange is the first request a device makes, so a
   * dead address fails there. Reporting that as "auth" hid it from the relay
   * fallback, which only steps in when the host was not reached at all.
   */
  it("reports an exchange that never reached the host as a network failure", async () => {
    const transport = await deviceTransport({
      endpoint: "https://h:1",
      tenantId: "t",
      deviceId: "d",
      privateKeyJwk,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:1")
      },
    })
    await expect(transport.execute("x")).resolves.toMatchObject({
      ok: false,
      cause: "network",
      message: "connect ECONNREFUSED 127.0.0.1:1",
    })
  })

  it("reports the host refusing the device as an auth failure", async () => {
    const transport = await deviceTransport({
      endpoint: "https://h:1",
      tenantId: "t",
      deviceId: "d",
      privateKeyJwk,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "device_revoked", detail: "device revoked" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    })
    await expect(transport.execute("x")).resolves.toMatchObject({
      ok: false,
      cause: "auth",
      status: 401,
    })
  })
})
