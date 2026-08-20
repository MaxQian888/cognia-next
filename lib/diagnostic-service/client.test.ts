import {
  DiagnosticServiceClient,
  DiagnosticServiceError,
  exchangeOidcGrant,
  normalizeServiceUrl,
  type DiagnosticFetch,
} from "./client"
import { rolePermits, DIAGNOSTIC_ROLES } from "./types"

interface Call {
  url: string
  init: RequestInit | undefined
}

function stub(responses: Response[] | Response): { fetchImpl: DiagnosticFetch; calls: Call[] } {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const calls: Call[] = []
  const fetchImpl: DiagnosticFetch = (input, init) => {
    calls.push({ url: String(input), init })
    const next = queue.shift()
    if (!next) throw new Error("unexpected extra request")
    return Promise.resolve(next)
  }
  return { fetchImpl, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function client(responses: Response[] | Response) {
  const { fetchImpl, calls } = stub(responses)
  return {
    calls,
    client: new DiagnosticServiceClient({
      baseUrl: "https://diag.example.com",
      grant: () => Promise.resolve("grant-token"),
      fetchImpl,
    }),
  }
}

describe("normalizeServiceUrl", () => {
  it("assumes https for a bare host and drops trailing slashes", () => {
    expect(normalizeServiceUrl("diag.example.com")).toBe("https://diag.example.com")
    expect(normalizeServiceUrl("https://diag.example.com///")).toBe("https://diag.example.com")
  })

  it("keeps a path prefix so a service behind a gateway path still resolves", () => {
    // `new URL("/v1/x", base)` would discard `/diagnostics`; every request path
    // is concatenated instead, and this is the test that pins that.
    expect(normalizeServiceUrl("https://gw.example.com/diagnostics/")).toBe(
      "https://gw.example.com/diagnostics"
    )
  })

  it("refuses a scheme that is not http(s), and refuses nothing at all", () => {
    expect(() => normalizeServiceUrl("javascript:alert(1)")).toThrow()
    expect(() => normalizeServiceUrl("   ")).toThrow()
  })

  it("discards a query string or fragment a paste may have carried in", () => {
    expect(normalizeServiceUrl("https://diag.example.com/?token=leaked#x")).toBe(
      "https://diag.example.com"
    )
  })
})

describe("rolePermits", () => {
  it("matches the service's own rung order", () => {
    expect(DIAGNOSTIC_ROLES).toEqual(["uploader", "viewer", "triager", "admin"])
    expect(rolePermits("uploader", "viewer")).toBe(false)
    expect(rolePermits("viewer", "viewer")).toBe(true)
    expect(rolePermits("admin", "triager")).toBe(true)
    expect(rolePermits("triager", "admin")).toBe(false)
  })
})

describe("DiagnosticServiceClient", () => {
  it("bearers the grant and asks for JSON on every request", async () => {
    const { client: subject, calls } = client(json([]))
    await subject.listGroups()
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("authorization")).toBe("Bearer grant-token")
    expect(headers.get("accept")).toBe("application/json")
  })

  it("omits empty filters rather than sending blank query parameters", async () => {
    const { client: subject, calls } = client(json([]))
    await subject.listGroups({ status: "open", platform: "", q: undefined, limit: 25 })
    expect(calls[0].url).toBe("https://diag.example.com/v1/groups?status=open&limit=25")
  })

  it("sends an explicit null to unassign but omits the key to leave it alone", async () => {
    const { client: subject, calls } = client([json({ id: "g1" }), json({ id: "g1" })])
    await subject.triageGroup("g1", { assignedTo: null })
    expect(calls[0].init?.body).toBe('{"assignedTo":null}')
    await subject.triageGroup("g1", { status: "resolved" })
    expect(calls[1].init?.body).toBe('{"status":"resolved"}')
  })

  it("refuses a triage call that would ask the service to change nothing", async () => {
    const { client: subject, calls } = client([])
    expect(() => subject.triageGroup("g1", {})).toThrow(DiagnosticServiceError)
    expect(calls).toHaveLength(0)
  })

  it("surfaces the service's machine-readable code, not its HTTP status alone", async () => {
    const { client: subject } = client(
      json({ error: { code: "raw_minidump_access_disabled" } }, 403)
    )
    const error = await subject.downloadArtifact("i1", 1).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DiagnosticServiceError)
    const typed = error as DiagnosticServiceError
    expect(typed.code).toBe("raw_minidump_access_disabled")
    expect(typed.isForbidden).toBe(true)
    expect(typed.isAuthFailure).toBe(false)
  })

  it("synthesizes a code when a gateway answers instead of the service", async () => {
    const { client: subject } = client(new Response("<html>502</html>", { status: 502 }))
    const error = (await subject
      .listGroups()
      .catch((cause: unknown) => cause)) as DiagnosticServiceError
    expect(error.code).toBe("http_502")
  })

  it("recognizes the intake kill switch so a caller can keep its spool", async () => {
    const { client: subject } = client(json({ error: { code: "ingest_disabled" } }, 503))
    const error = (await subject
      .createIncident({
        artifactHash: "a".repeat(64),
        buildId: "1.0.0",
        platform: "macos",
        module: "cognia",
        exception: "panic",
        attachmentCount: 1,
        eventCount: 0,
        totalBytes: 10,
        largestAttachmentBytes: 10,
        largestMinidumpBytes: 0,
        consent: true,
      })
      .catch((cause: unknown) => cause)) as DiagnosticServiceError
    expect(error.isIngestDisabled).toBe(true)
  })

  it("treats 204 as success with no body rather than trying to parse one", async () => {
    const { client: subject } = client(new Response(null, { status: 204 }))
    await expect(subject.withdrawConsent("i1")).resolves.toBeUndefined()
  })

  it("sends a part as bytes with its checksum and kind", async () => {
    const { client: subject, calls } = client(json({ partNumber: 1 }, 201))
    await subject.uploadPart("i1", 1, new Uint8Array([1, 2, 3]), "b".repeat(64), "minidump")
    const headers = new Headers(calls[0].init?.headers)
    expect(calls[0].url).toBe("https://diag.example.com/v1/incidents/i1/parts/1")
    expect(headers.get("x-part-sha256")).toBe("b".repeat(64))
    expect(headers.get("x-artifact-kind")).toBe("minidump")
    expect(headers.get("content-type")).toBe("application/octet-stream")
  })

  it("refuses to send anything when the grant callback comes back empty", async () => {
    const { fetchImpl, calls } = stub([])
    const subject = new DiagnosticServiceClient({
      baseUrl: "https://diag.example.com",
      grant: () => Promise.resolve(""),
      fetchImpl,
    })
    await expect(subject.listGroups()).rejects.toMatchObject({ code: "grant_required" })
    expect(calls).toHaveLength(0)
  })

  it("percent-encodes path segments so an id cannot escape its route", async () => {
    const { client: subject, calls } = client(json({}))
    await subject.getIncident("../admin/tenant")
    expect(calls[0].url).toBe("https://diag.example.com/v1/incidents/..%2Fadmin%2Ftenant")
  })
})

describe("exchangeOidcGrant", () => {
  it("posts the session token and returns the role the service assigned", async () => {
    const { fetchImpl, calls } = stub(json({ grant: "g", role: "triager", expiresInSeconds: 900 }))
    const result = await exchangeOidcGrant({
      baseUrl: "https://diag.example.com",
      sessionToken: "session-jwt",
      installationId: "install-1",
      fetchImpl,
    })
    expect(calls[0].url).toBe("https://diag.example.com/v1/grants/oidc")
    expect(calls[0].init?.body).toBe('{"sessionToken":"session-jwt","installationId":"install-1"}')
    expect(result).toEqual({ grant: "g", role: "triager", expiresInSeconds: 900 })
  })

  it("reports a rejected session as an auth failure", async () => {
    const { fetchImpl } = stub(json({ error: { code: "invalid_oidc_session" } }, 401))
    const error = (await exchangeOidcGrant({
      baseUrl: "https://diag.example.com",
      sessionToken: "bad",
      installationId: "install-1",
      fetchImpl,
    }).catch((cause: unknown) => cause)) as DiagnosticServiceError
    expect(error.isAuthFailure).toBe(true)
    expect(error.code).toBe("invalid_oidc_session")
  })
})
