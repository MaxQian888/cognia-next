import { CollabClient, CollabConflictError, CollabError } from "./client"

const ORG = "org_acme00000000000000000"
const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

interface Call {
  url: string
  init?: RequestInit
}

/** A fetch double that answers grant exchanges and records everything. */
function harness(
  options: {
    grantExpiresAt?: number
    issues?: unknown[]
    issueStatuses?: number[]
  } = {}
) {
  const calls: Call[] = []
  const statuses = [...(options.issueStatuses ?? [])]
  let exchanges = 0

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    if (url.endsWith("/grants")) {
      exchanges += 1
      return jsonResponse({
        grant: `grant-${exchanges}`,
        userId: ADA,
        orgId: ORG,
        expiresAt: options.grantExpiresAt ?? 1_000,
      })
    }
    const status = statuses.shift() ?? 200
    if (status !== 200) return jsonResponse({ error: "nope" }, status)
    return jsonResponse(options.issues ?? [])
  }

  return { calls, fetchImpl, exchanges: () => exchanges }
}

function grantHeader(call: Call): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.authorization
}

describe("CollabClient", () => {
  it("exchanges the access token for a grant, then uses the grant", async () => {
    const { calls, fetchImpl } = harness()
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG)

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(`https://collab.test/v1/orgs/${ORG}/grants`)
    expect(grantHeader(calls[0])).toBe("Bearer logto-token")
    expect(calls[1].url).toBe(`https://collab.test/v1/orgs/${ORG}/issues`)
    expect(grantHeader(calls[1])).toBe("Bearer grant-1")
  })

  it("reuses a cached grant across requests", async () => {
    const { fetchImpl, exchanges } = harness({ grantExpiresAt: 1_000 })
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG)
    await client.listIssues(ORG)
    await client.listEvents(ORG, "iss_1")

    expect(exchanges()).toBe(1)
  })

  it("resolves the server-owned user id without exposing the grant", async () => {
    const { fetchImpl } = harness()
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })
    await expect(client.identity(ORG)).resolves.toEqual({ userId: ADA, orgId: ORG })
  })

  it("re-exchanges before the grant actually expires", async () => {
    // Expiring mid-flight costs the caller a 401 to recover from; one extra
    // exchange is the cheaper trade.
    const { fetchImpl, exchanges } = harness({ grantExpiresAt: 100 })
    let now = 0
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => now,
    })

    await client.listIssues(ORG)
    expect(exchanges()).toBe(1)

    // 80s in: 20s of life left, inside the 30s margin.
    now = 80_000
    await client.listIssues(ORG)
    expect(exchanges()).toBe(2)
  })

  it("keeps one grant per org rather than thrashing a single slot", async () => {
    const { fetchImpl, exchanges } = harness({ grantExpiresAt: 10_000 })
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG)
    await client.listIssues("org_bbbbbbbbbbbbbbbbbbbbbb")
    await client.listIssues(ORG)

    expect(exchanges()).toBe(2)
  })

  it("retries once with a fresh grant on a 401, then gives up", async () => {
    const { calls, fetchImpl, exchanges } = harness({
      grantExpiresAt: 10_000,
      issueStatuses: [401, 200],
    })
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG)

    expect(exchanges()).toBe(2)
    expect(grantHeader(calls[calls.length - 1])).toBe("Bearer grant-2")
  })

  it("stops after one retry rather than looping on a persistent 401", async () => {
    const { fetchImpl, exchanges } = harness({
      grantExpiresAt: 10_000,
      issueStatuses: [401, 401],
    })
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await expect(client.listIssues(ORG)).rejects.toBeInstanceOf(CollabError)
    expect(exchanges()).toBe(2)
  })

  it("reports not-signed-in as a 401 without calling the network", async () => {
    // A profile nobody signed in on has no collaboration plane. That is a
    // normal state, and the board falls back to its local issues.
    const { calls, fetchImpl } = harness()
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => null,
      fetchImpl,
    })

    await expect(client.listIssues(ORG)).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(0)
  })

  it("surfaces the server's error message rather than a generic one", async () => {
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl: async (url) =>
        url.endsWith("/grants")
          ? jsonResponse({ error: "this identity is not a member of that organisation" }, 403)
          : jsonResponse([]),
      now: () => 0,
    })

    await expect(client.listIssues(ORG)).rejects.toThrow(
      "this identity is not a member of that organisation"
    )
  })

  it("survives a non-JSON error body", async () => {
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl: async () => new Response("<html>502</html>", { status: 502 }),
      now: () => 0,
    })

    await expect(client.listIssues(ORG)).rejects.toThrow("collaboration plane returned 502")
  })

  it("encodes query parameters and skips empty ones", async () => {
    const { calls, fetchImpl } = harness()
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG, { workspaceId: "proj 1", issueProjectId: "" })

    const listed = calls[calls.length - 1].url
    expect(listed).toContain("workspaceId=proj+1")
    expect(listed).not.toContain("issueProjectId")
  })

  it("forgets a grant on request, so signing out cannot leak the previous person's", async () => {
    const { fetchImpl, exchanges } = harness({ grantExpiresAt: 10_000 })
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG)
    client.forgetGrant()
    await client.listIssues(ORG)

    expect(exchanges()).toBe(2)
  })

  it("normalises the base url so a trailing slash cannot double up", async () => {
    const { calls, fetchImpl } = harness()
    const client = new CollabClient({
      baseUrl: "collab.test/",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.listIssues(ORG)
    expect(calls[0].url).toBe(`https://collab.test/v1/orgs/${ORG}/grants`)
  })

  it("sends a stable operation id and base revision on writes", async () => {
    const { calls, fetchImpl } = harness({ issues: [{ id: "iss_1" }] })
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl,
      now: () => 0,
    })

    await client.patchIssue(ORG, "iss_1", {
      operationId: "op-1",
      baseRevision: 4,
      title: "Changed",
    })

    const call = calls[calls.length - 1]
    expect(call.init?.method).toBe("PATCH")
    expect(JSON.parse(String(call.init?.body))).toEqual({
      operationId: "op-1",
      baseRevision: 4,
      title: "Changed",
    })
    expect(call.init?.headers).toMatchObject({
      authorization: "Bearer grant-1",
      "content-type": "application/json",
    })
  })

  it("carries the authoritative resource on a revision conflict", async () => {
    const client = new CollabClient({
      baseUrl: "https://collab.test",
      accessToken: async () => "logto-token",
      fetchImpl: async (url) =>
        url.endsWith("/grants")
          ? jsonResponse({ grant: "grant-1", userId: ADA, orgId: ORG, expiresAt: 1_000 })
          : jsonResponse(
              { error: "revision conflict", authoritative: { id: "iss_1", revision: 5 } },
              409
            ),
      now: () => 0,
    })

    const error = await client
      .patchIssue(ORG, "iss_1", { operationId: "op-1", baseRevision: 4 })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(CollabConflictError)
    expect(error).toMatchObject({
      status: 409,
      authoritative: { id: "iss_1", revision: 5 },
    })
  })
})
