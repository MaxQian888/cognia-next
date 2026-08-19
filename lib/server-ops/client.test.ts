import {
  OpsClient,
  OpsError,
  loadCachedServerList,
  saveCachedServerList,
  type ServerSummary,
} from "./client"

const server: ServerSummary = {
  id: "production",
  label: "Production",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "healthy",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  lastSeenAt: "2026-08-01T10:00:00Z",
}

describe("OpsClient", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })

  it("retries bounded GET failures and authenticates every request", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [server] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
      sleep: () => Promise.resolve(),
    })

    await expect(client.listServers()).resolves.toEqual([server])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("authorization")).toBe(
      "Bearer access-token"
    )
  })

  it("uses the caller's idempotency key for mutation retries", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "op-1", state: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      )
    const client = new OpsClient({
      baseUrl: "https://ops.example.com/",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
      sleep: () => Promise.resolve(),
    })

    await client.createBackup("production", "backup-click-1")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("backup-click-1")
    }
  })

  it("registers a target before queueing its immutable release", async () => {
    const registered = {
      ...server,
      targetRevision: 3,
      productionCertified: true,
      certificationIssues: [],
      capabilities: { snapshotProviders: [], secretProviders: [] },
    }
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(registered), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "op-deploy", state: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      )
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })
    const target = { apiVersion: "deploy.cognia.dev/v1alpha1" }
    const release = {
      targetRevision: 3,
      release: {
        serverImage: `server@sha256:${"a".repeat(64)}`,
        runnerImage: `runner@sha256:${"b".repeat(64)}`,
        workspaceRuntimeImage: `runtime@sha256:${"c".repeat(64)}`,
        configRevision: "3",
      },
    }

    await expect(client.registerTarget(target, "register-1")).resolves.toEqual(registered)
    await expect(client.deploy("production", release, "deploy-1")).resolves.toEqual({
      id: "op-deploy",
      state: "queued",
    })
    expect(new URL(fetchImpl.mock.calls[0][0] as string).pathname).toBe("/v1/targets")
    expect(new URL(fetchImpl.mock.calls[1][0] as string).pathname).toBe(
      "/v1/servers/production/deploy"
    )
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("idempotency-key")).toBe(
      "register-1"
    )
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("idempotency-key")).toBe("deploy-1")
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual(release)
  })

  it("requests rollback without accepting a client-selected release", async () => {
    const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>().mockResolvedValue(
      new Response(JSON.stringify({ id: "op-rollback", state: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    )
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    await client.rollback("production", "admin-lease", "rollback-1")

    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({})
    expect(new Headers(init?.headers).get("x-admin-lease")).toBe("admin-lease")
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("rollback-1")
  })

  it("surfaces typed controller errors without leaking response bodies", async () => {
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("expired"),
      fetchImpl: jest.fn(
        async () =>
          new Response(JSON.stringify({ code: "unauthorized", message: "Sign in again" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
      ),
    })

    await expect(client.listServers()).rejects.toEqual(
      expect.objectContaining<Partial<OpsError>>({
        name: "OpsError",
        code: "unauthorized",
        status: 401,
        message: "Sign in again",
      })
    )
  })

  it("exposes every read endpoint with encoded ids and bounded log limits", async () => {
    const detail = {
      ...server,
      targetRevision: 1,
      productionCertified: true,
      certificationIssues: [],
      capabilities: {},
    }
    const capabilities = {
      topologies: ["compose"],
      snapshotProviders: ["external-command"],
      secretProviders: ["file"],
      tlsProviders: ["existing"],
      objectStoreProtocols: ["s3-compatible"],
      requiresProviderCredentials: false,
    }
    const log = {
      id: 1,
      serverId: "tenant/a",
      timestamp: "2026-08-01T10:00:00Z",
      level: "info",
      component: "server",
      message: "ready",
    }
    const backup = {
      id: "rp-1",
      serverId: "tenant/a",
      createdAt: "2026-08-01T10:00:00Z",
      kind: "snapshot",
      manifestSha256: "a".repeat(64),
      sizeBytes: 12,
      verified: true,
    }
    const operation = { id: "operation/a", state: "succeeded" }
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(jsonResponse(capabilities))
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(jsonResponse({ items: [log] }))
      .mockResolvedValueOnce(jsonResponse({ items: [log] }))
      .mockResolvedValueOnce(jsonResponse({ items: [backup] }))
      .mockResolvedValueOnce(jsonResponse(operation))
    const client = new OpsClient({
      baseUrl: "https://ops.example.com/root/?ignored=yes#fragment",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    await expect(client.capabilities()).resolves.toEqual(capabilities)
    await expect(client.getServer("tenant/a")).resolves.toEqual(detail)
    await expect(client.listLogs("tenant/a", 0)).resolves.toEqual([log])
    await expect(client.listLogs("tenant/a", 5_000)).resolves.toEqual([log])
    await expect(client.listBackups("tenant/a")).resolves.toEqual([backup])
    await expect(client.getOperation("operation/a")).resolves.toEqual(operation)

    expect(fetchImpl.mock.calls.map(([input]) => new URL(input as string).pathname)).toEqual([
      "/v1/providers/capabilities",
      "/v1/servers/tenant%2Fa",
      "/v1/servers/tenant%2Fa/logs",
      "/v1/servers/tenant%2Fa/logs",
      "/v1/servers/tenant%2Fa/backups",
      "/v1/operations/operation%2Fa",
    ])
    expect(new URL(fetchImpl.mock.calls[2][0] as string).search).toBe("?limit=1")
    expect(new URL(fetchImpl.mock.calls[3][0] as string).search).toBe("?limit=1000")
  })

  it("sends typed mutation bodies and admin leases", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockImplementation(async () => jsonResponse({ id: "op" }, 202))
    const client = new OpsClient({
      baseUrl: "http://127.0.0.1:4100",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    await client.validateTarget({ metadata: { id: "target" } }, "validate-1")
    await client.upgrade(
      "target/a",
      {
        targetRevision: 3,
        release: {
          serverImage: "server@sha256:aa",
          runnerImage: "runner@sha256:bb",
          workspaceRuntimeImage: "runtime@sha256:cc",
          configRevision: "3",
        },
      },
      "upgrade-1"
    )
    await client.createAdminLease("target/a", "restore", "lease-1")
    await client.restore("target/a", "rp-1", "lease-token", "restore-1")
    await client.rotateKey("target/a", "key-v2", "lease-token", "rotate-1")

    const requests = fetchImpl.mock.calls.map(([input, init]) => ({
      path: new URL(input as string).pathname,
      body: JSON.parse(String(init?.body)),
      lease: new Headers(init?.headers).get("x-admin-lease"),
    }))
    expect(requests).toEqual([
      { path: "/v1/targets/validate", body: { metadata: { id: "target" } }, lease: null },
      {
        path: "/v1/servers/target%2Fa/upgrade",
        body: {
          targetRevision: 3,
          release: {
            serverImage: "server@sha256:aa",
            runnerImage: "runner@sha256:bb",
            workspaceRuntimeImage: "runtime@sha256:cc",
            configRevision: "3",
          },
        },
        lease: null,
      },
      {
        path: "/v1/admin-leases",
        body: { targetId: "target/a", operation: "restore", ttlSeconds: 300 },
        lease: null,
      },
      {
        path: "/v1/servers/target%2Fa/restore",
        body: { recoveryPointId: "rp-1" },
        lease: "lease-token",
      },
      {
        path: "/v1/servers/target%2Fa/rotate-key",
        body: { keyVersion: "key-v2" },
        lease: "lease-token",
      },
    ])
  })

  it("queues the operation kinds the controller derives server-side", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockImplementation(async () => jsonResponse({ id: "op" }, 202))
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    // Preflight sends nothing: the controller refuses a client-supplied
    // revision, so a body here would be a 400 rather than a hint.
    await client.preflight("production", "preflight-1")
    await client.collectStatus("production", "status-1")
    await client.collectStatus("production", "status-2", { includeRuntimeUsage: true })
    await client.collectLogs("production", "logs-1")
    await client.collectLogs("production", "logs-2", { afterEventId: 7, limit: 5000 })

    expect(
      fetchImpl.mock.calls.map(([input, init]) => [
        new URL(input as string).pathname,
        JSON.parse(String(init?.body)),
      ])
    ).toEqual([
      ["/v1/servers/production/preflight", {}],
      ["/v1/servers/production/collect-status", {}],
      ["/v1/servers/production/collect-status", { includeRuntimeUsage: true }],
      ["/v1/servers/production/collect-logs", {}],
      // The agent's own ceiling is 1000 lines; a larger ask is clamped rather
      // than rejected at the controller.
      ["/v1/servers/production/collect-logs", { afterEventId: 7, limit: 1000 }],
    ])
  })

  it("issues enrollment tokens with a clamped lifetime and cancels operations", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockImplementation(async () => jsonResponse({ token: "enroll", expiresAt: "2026-08-01" }))
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    await expect(client.createEnrollmentToken("staging", "enroll-1")).resolves.toEqual({
      token: "enroll",
      expiresAt: "2026-08-01",
    })
    await client.createEnrollmentToken("staging", "enroll-2", 5)
    await client.createEnrollmentToken("staging", "enroll-3", 99999)
    await client.cancelOperation("op/1", "cancel-1")

    expect(
      fetchImpl.mock.calls.map(([input, init]) => [
        new URL(input as string).pathname,
        JSON.parse(String(init?.body)),
      ])
    ).toEqual([
      ["/v1/agents/enrollment-tokens", { targetId: "staging", ttlSeconds: 900 }],
      // The controller clamps to 60..3600 too; clamping here keeps the UI from
      // showing a countdown the controller will not honour.
      ["/v1/agents/enrollment-tokens", { targetId: "staging", ttlSeconds: 60 }],
      ["/v1/agents/enrollment-tokens", { targetId: "staging", ttlSeconds: 3600 }],
      ["/v1/operations/op%2F1/cancel", {}],
    ])
  })

  it("reads operation history and one operation's trail", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockImplementation(async () => jsonResponse({ items: [] }))
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    await client.listOperations()
    await client.listOperations({ targetId: "tenant/a", limit: 10 })
    await client.listOperations({ limit: 9000 })
    await client.listOperationEvents("op/1")

    expect(
      fetchImpl.mock.calls.map(([input]) => {
        const url = new URL(input as string)
        return url.pathname + url.search
      })
    ).toEqual([
      // No query at all rather than an empty `?`, so the controller's defaults
      // apply verbatim.
      "/v1/operations",
      "/v1/operations?targetId=tenant%2Fa&limit=10",
      // The controller clamps to 500 too; clamping here keeps the request
      // honest about what it will get back.
      "/v1/operations?limit=500",
      "/v1/operations/op%2F1/events",
    ])
  })

  it("delegates event streaming to an injected transport", async () => {
    // Desktop cannot open the SSE stream from the renderer at all, so the
    // client must hand the whole job to the native transport rather than
    // falling back to its own reader.
    const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>()
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
      eventStream: async function* (options) {
        expect(options.lastEventId).toBe(9)
        yield {
          id: 10,
          operationId: "op-1",
          targetId: "t",
          state: "succeeded" as const,
          timestamp: "",
          message: "",
        }
      },
    })

    const seen = []
    for await (const event of client.streamEvents({ lastEventId: 9 })) seen.push(event)
    expect(seen).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("parses operation events and resumes with Last-Event-ID", async () => {
    const first = { id: 2, operationId: "op-1", targetId: "target", state: "executing" }
    const second = { id: 3, operationId: "op-1", targetId: "target", state: "succeeded" }
    const stream = [
      ": heartbeat\n\n",
      `id: 2\ndata: ${JSON.stringify(first)}\n\n`,
      `id: 3\ndata: ${JSON.stringify(second).slice(0, 20)}`,
      `${JSON.stringify(second).slice(20)}\n\n`,
    ]
    const fetchImpl = jest.fn<Promise<Response>, Parameters<typeof fetch>>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of stream) controller.enqueue(new TextEncoder().encode(chunk))
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    )
    const client = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    const events = []
    for await (const event of client.streamEvents({ lastEventId: 1 })) events.push(event)

    expect(events).toEqual([first, second])
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("last-event-id")).toBe("1")
  })

  it("rejects unsafe controller URLs, empty auth, and missing idempotency keys", async () => {
    expect(
      () =>
        new OpsClient({
          baseUrl: "http://ops.example.com",
          accessToken: () => Promise.resolve("token"),
        })
    ).toThrow("Ops Controller must use HTTPS")

    const client = new OpsClient({
      baseUrl: "http://localhost:4100",
      accessToken: () => Promise.resolve(""),
      fetchImpl: jest.fn(),
    })
    await expect(client.listServers()).rejects.toEqual(
      expect.objectContaining({ code: "authentication_required", status: 401 })
    )
    await expect(client.createBackup("target", "  ")).rejects.toThrow("idempotencyKey is required")
  })

  it("returns typed fallback errors for invalid responses and exhausted networks", async () => {
    const invalidResponseClient = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("token"),
      fetchImpl: jest.fn(async () => new Response("proxy error", { status: 502 })),
    })
    await expect(invalidResponseClient.listServers()).rejects.toEqual(
      expect.objectContaining({
        code: "controller_error",
        status: 502,
        message: "Controller returned 502",
      })
    )

    const networkClient = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("token"),
      fetchImpl: jest.fn(async () => {
        throw "offline"
      }),
      sleep: () => Promise.resolve(),
    })
    await expect(networkClient.listServers()).rejects.toEqual(
      expect.objectContaining({ code: "network_unavailable", message: "Controller is unavailable" })
    )
  })

  it("handles empty successful and unavailable event-stream responses", async () => {
    const noContent = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("token"),
      fetchImpl: jest.fn(async () => new Response(null, { status: 204 })),
    })
    await expect(noContent.validateTarget({}, "validate-empty")).resolves.toBeUndefined()

    const missingBody = new OpsClient({
      baseUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve("token"),
      fetchImpl: jest.fn(async () => new Response(null, { status: 200 })),
    })
    const events = missingBody.streamEvents()
    await expect(events.next()).rejects.toEqual(
      expect.objectContaining({ code: "event_stream_unavailable", status: 200 })
    )
  })
})

describe("server operations offline cache", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
  beforeEach(() => values.clear())

  it("isolates non-sensitive summaries by account and target", () => {
    saveCachedServerList(storage, "account-a", "target-a", [server])

    expect(loadCachedServerList(storage, "account-a", "target-a")).toEqual([server])
    expect(loadCachedServerList(storage, "account-b", "target-a")).toEqual([])
    expect(loadCachedServerList(storage, "account-a", "target-b")).toEqual([])
    expect([...values.values()].join("\n")).not.toMatch(/token|credential|secret/i)
  })

  it("drops malformed cache entries and filters invalid summaries", () => {
    storage.setItem("cognia.server-ops.v1.account-a.target-a", "not-json")
    expect(loadCachedServerList(storage, "account-a", "target-a")).toEqual([])
    expect(values.has("cognia.server-ops.v1.account-a.target-a")).toBe(false)

    storage.setItem(
      "cognia.server-ops.v1.account-a.target-a",
      JSON.stringify({
        servers: [
          server,
          null,
          { ...server, id: 12 },
          { ...server, label: 12 },
          { ...server, topology: 12 },
          { ...server, publicUrl: 12 },
          { ...server, health: "excellent" },
          { ...server, releaseDigest: 12 },
          { ...server, lastSeenAt: 12 },
        ],
      })
    )
    expect(loadCachedServerList(storage, "account-a", "target-a")).toEqual([server])

    storage.setItem(
      "cognia.server-ops.v1.account-a.target-a",
      JSON.stringify({ servers: "not-an-array" })
    )
    expect(loadCachedServerList(storage, "account-a", "target-a")).toEqual([])
  })
})
