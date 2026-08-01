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
      .fn<typeof fetch>()
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
      .fn<typeof fetch>()
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
      .fn<typeof fetch>()
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
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
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
      .fn<typeof fetch>()
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
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ id: "op" }, 202))
    const client = new OpsClient({
      baseUrl: "http://127.0.0.1:4100",
      accessToken: () => Promise.resolve("access-token"),
      fetchImpl,
    })

    await client.validateTarget({ metadata: { id: "target" } }, "validate-1")
    await client.upgrade("target/a", { release: "digest" }, "upgrade-1")
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
        body: { release: "digest" },
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

  it("parses operation events and resumes with Last-Event-ID", async () => {
    const first = { id: 2, operationId: "op-1", targetId: "target", state: "executing" }
    const second = { id: 3, operationId: "op-1", targetId: "target", state: "succeeded" }
    const stream = [
      ": heartbeat\n\n",
      `id: 2\ndata: ${JSON.stringify(first)}\n\n`,
      `id: 3\ndata: ${JSON.stringify(second).slice(0, 20)}`,
      `${JSON.stringify(second).slice(20)}\n\n`,
    ]
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
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
