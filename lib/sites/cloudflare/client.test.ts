import { CloudflareSitesClient, CloudflareSitesError } from "./client"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cf-ray": "ray_1" },
  })
}

function callsOf(fetcher: jest.Mock): Array<[RequestInfo | URL, RequestInit?]> {
  return fetcher.mock.calls as Array<[RequestInfo | URL, RequestInit?]>
}

describe("CloudflareSitesClient", () => {
  it("authenticates requests and unwraps Cloudflare result envelopes", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { status: "active" } })
    )
    const client = new CloudflareSitesClient({ token: "secret", fetcher })

    await expect(client.verifyToken()).resolves.toEqual({ status: "active" })
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      })
    )
  })

  it("returns typed errors without including the credential", async () => {
    const fetcher = jest.fn(async () =>
      response(
        {
          success: false,
          errors: [{ code: 10090, message: "permission denied" }],
          messages: [],
          result: null,
        },
        403
      )
    )
    const client = new CloudflareSitesClient({ token: "never-print-me", fetcher })

    await expect(client.verifyToken()).rejects.toMatchObject<Partial<CloudflareSitesError>>({
      name: "CloudflareSitesError",
      status: 403,
      requestId: "ray_1",
      codes: [10090],
    })
    await expect(client.verifyToken()).rejects.not.toThrow("never-print-me")
  })

  it("creates D1/R2 resources and deploys a previously uploaded version", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { id: "result_1" } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.createD1Database("account_1", { name: "docs-db", jurisdiction: "eu" })
    await client.createR2Bucket("account_1", { name: "docs-bucket", jurisdiction: "eu" })
    await client.createDeployment("account_1", "docs-worker", {
      versionId: "version_1",
      message: "Cognia Site version 4",
    })

    const calls = callsOf(fetcher)
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account_1/d1/database",
      "https://api.cloudflare.com/client/v4/accounts/account_1/r2/buckets",
      "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker/deployments",
    ])
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({
      strategy: "percentage",
      versions: [{ version_id: "version_1", percentage: 100 }],
      annotations: {
        "workers/message": "Cognia Site version 4",
        "workers/triggered_by": "cognia-sites",
      },
    })
  })

  it("fails closed before sending an unreviewed request body containing PII", async () => {
    const fetcher = jest.fn()
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await expect(
      client.createDeployment("account_1", "docs-worker", {
        versionId: "version_1",
        message: "Contact alice@example.com",
      })
    ).rejects.toThrow("outbound PII gate")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("permits explicit secret-management and access-policy identity payloads", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { id: "ok" } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.bulkUpdateSecrets("account_1", "docs-worker", {
      CONTACT: "alice@example.com",
    })
    await client.createAccessPolicy("account_1", "app_1", {
      include: [{ email: { email: "alice@example.com" } }],
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("updates secrets, manages domains, and exposes takedown/delete operations", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { id: "ok" } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.bulkUpdateSecrets("account_1", "docs-worker", {
      API_TOKEN: "value",
      OLD_TOKEN: null,
    })
    await client.attachDomain("account_1", {
      zoneId: "zone_1",
      hostname: "docs.example.com",
      workerName: "docs-worker",
    })
    await client.detachDomain("account_1", "domain/id")
    await client.setWorkersDev("account_1", "docs-worker", false)
    await client.deleteWorker("account_1", "docs-worker")

    const calls = callsOf(fetcher)
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker/secrets-bulk",
        "PATCH",
      ],
      ["https://api.cloudflare.com/client/v4/accounts/account_1/workers/domains", "PUT"],
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/domains/domain%2Fid",
        "DELETE",
      ],
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker/subdomain",
        "POST",
      ],
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker",
        "DELETE",
      ],
    ])
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      secrets: {
        API_TOKEN: { name: "API_TOKEN", text: "value", type: "secret_text" },
        OLD_TOKEN: null,
      },
    })
  })

  it("queries persisted logs and analytics without inventing a staging deployment", async () => {
    const fetcher = jest.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/graphql")
        ? response({ data: { viewer: {} } })
        : response({ success: true, errors: [], messages: [], result: { events: [] } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.queryWorkerLogs("account_1", {
      workerName: "docs-worker",
      from: 100,
      to: 200,
      errorsOnly: true,
      limit: 50,
    })
    await client.queryWorkerAnalytics("account_1", {
      workerName: "docs-worker",
      from: "2026-07-17T00:00:00Z",
      to: "2026-07-18T00:00:00Z",
      zoneId: "zone_1",
      hostname: "docs.example.com",
    })

    const calls = callsOf(fetcher)
    expect(String(calls[0][0])).toContain("/workers/observability/telemetry/query")
    const logBody = JSON.parse(String(calls[0][1]?.body))
    expect(logBody.view).toBe("events")
    expect(logBody.parameters.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "$metadata.service", value: "docs-worker" }),
        expect.objectContaining({ key: "$metadata.error", operation: "exists" }),
      ])
    )
    expect(calls[1][0]).toBe("https://api.cloudflare.com/client/v4/graphql")
    expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
      variables: { accountTag: "account_1", scriptName: "docs-worker" },
    })
    expect(JSON.parse(String(calls[2][1]?.body))).toMatchObject({
      variables: { zoneTag: "zone_1", hostname: "docs.example.com" },
    })
    expect(String(calls[2][1]?.body)).toContain("pageViews")
  })

  it("covers the complete provider lifecycle surface with encoded resource identifiers", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: [{ id: "provider-row" }] })
    )
    const client = new CloudflareSitesClient({
      token: "token",
      fetcher,
      baseUrl: "https://provider.example/",
    })

    await client.listD1Databases("account/id")
    await client.deleteD1Database("account/id", "database/id")
    await client.listR2Buckets("account/id")
    await client.deleteR2Bucket("account/id", "bucket/id", "eu")
    await client.listVersions("account/id", "worker/id")
    await client.deleteVersion("account/id", "worker/id", "version/id")
    await client.createDeployment("account/id", "worker/id", {
      versionId: "version/id",
      force: true,
    })
    await client.listDeployments("account/id", "worker/id")
    await client.listDomains("account/id")
    await client.getWorkersSubdomain("account/id")
    await client.createAccessApplication("account/id", { name: "Docs" })
    await client.listAccessApplications("account/id")
    await client.updateAccessApplication("account/id", "application/id", { name: "Docs 2" })
    await client.deleteAccessApplication("account/id", "application/id")
    await client.listAccessPolicies("account/id", "application/id")
    await client.createAccessPolicy("account/id", "application/id", { name: "Allow" })
    await client.updateAccessPolicy("account/id", "application/id", "policy/id", {
      name: "Allow 2",
    })
    await client.deleteAccessPolicy("account/id", "application/id", "policy/id")
    await client.queryWorkerLogs("account/id", {
      workerName: "worker/id",
      from: 1,
      to: 2,
      limit: 9_999,
    })

    const urls = callsOf(fetcher).map(([url]) => String(url))
    expect(urls).toContain(
      "https://provider.example/accounts/account%2Fid/d1/database/database%2Fid"
    )
    expect(urls).toContain(
      "https://provider.example/accounts/account%2Fid/workers/scripts/worker%2Fid/deployments?force=true"
    )
    const logsCall = callsOf(fetcher).at(-1)
    expect(JSON.parse(String(logsCall?.[1]?.body))).toMatchObject({ limit: 500 })
  })

  it("normalizes R2 list envelopes and optional jurisdiction headers", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response({ success: true, result: { buckets: [{ name: "one" }] } }))
      .mockResolvedValueOnce(response({ success: true, result: [{ name: "two" }] }))
      .mockResolvedValueOnce(response({ success: true, result: { name: "created" } }))
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await expect(client.listR2Buckets("account")).resolves.toEqual([{ name: "one" }])
    await expect(client.listR2Buckets("account")).resolves.toEqual([{ name: "two" }])
    await client.createR2Bucket("account", { name: "created" })
    expect(callsOf(fetcher)[2][1]?.headers).not.toHaveProperty("cf-r2-jurisdiction")
  })

  it("fails closed for empty credentials, malformed REST, and GraphQL errors", async () => {
    expect(() => new CloudflareSitesClient({ token: "  " })).toThrow(
      "Cloudflare API token is required"
    )

    const malformed = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => new Response("not-json", { status: 502 })),
    })
    await expect(malformed.verifyToken()).rejects.toMatchObject({
      message: "Cloudflare request failed with HTTP 502",
      status: 502,
      codes: [],
    })

    const graphqlError = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => response({ errors: [{ code: 9109, message: "forbidden" }] })),
    })
    await expect(
      graphqlError.queryWorkerAnalytics("account", {
        workerName: "worker",
        from: "start",
        to: "end",
      })
    ).rejects.toMatchObject({ message: "forbidden", codes: [9109] })

    const malformedGraphql = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => new Response("not-json", { status: 500 })),
    })
    await expect(
      malformedGraphql.queryWorkerAnalytics("account", {
        workerName: "worker",
        from: "start",
        to: "end",
      })
    ).rejects.toMatchObject({ message: "Cloudflare GraphQL request failed with HTTP 500" })
  })
})
