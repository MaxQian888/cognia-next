import {
  clearDiagnosticConnection,
  DiagnosticGrantCache,
  loadDiagnosticConnection,
  loadDiagnosticSessionToken,
  saveDiagnosticConnection,
  saveDiagnosticSessionToken,
  type ConnectionStoreDeps,
  type StoredDiagnosticConnection,
} from "./connection"
import type { DiagnosticFetch } from "./client"

function memoryStores(): Required<ConnectionStoreDeps> & { localMap: Map<string, string> } {
  const localMap = new Map<string, string>()
  const keyringMap = new Map<string, string>()
  return {
    localMap,
    local: {
      getItem: (key) => localMap.get(key) ?? null,
      setItem: (key, value) => void localMap.set(key, value),
      removeItem: (key) => void localMap.delete(key),
    },
    keyring: {
      save: (key, value) => {
        keyringMap.set(key, value)
        return Promise.resolve()
      },
      load: (key) => Promise.resolve(keyringMap.get(key) ?? null),
      delete: (key) => {
        keyringMap.delete(key)
        return Promise.resolve()
      },
    },
  }
}

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  installationId: "install-1",
  autoSubmit: false,
  lastKnownRole: null,
}

describe("connection persistence", () => {
  it("round-trips a connection per account", () => {
    const deps = memoryStores()
    saveDiagnosticConnection("account-a", connection, deps)
    expect(loadDiagnosticConnection("account-a", deps)).toEqual(connection)
    // A second local account is a different service by default.
    expect(loadDiagnosticConnection("account-b", deps)).toBeNull()
  })

  it("normalizes the URL on the way in so a stored value is always usable", () => {
    const deps = memoryStores()
    saveDiagnosticConnection("account-a", { ...connection, baseUrl: "diag.example.com/" }, deps)
    expect(loadDiagnosticConnection("account-a", deps)?.baseUrl).toBe("https://diag.example.com")
  })

  it("discards a record it cannot trust instead of returning half of one", () => {
    const deps = memoryStores()
    deps.localMap.set("cognia.diagnostic-service.connection.account-a", "{not json")
    expect(loadDiagnosticConnection("account-a", deps)).toBeNull()
    expect(deps.localMap.size).toBe(0)

    deps.localMap.set(
      "cognia.diagnostic-service.connection.account-a",
      JSON.stringify({ baseUrl: "https://diag.example.com" })
    )
    expect(loadDiagnosticConnection("account-a", deps)).toBeNull()
    expect(deps.localMap.size).toBe(0)
  })

  it("treats a missing autoSubmit as off rather than inheriting a truthy default", () => {
    const deps = memoryStores()
    deps.localMap.set(
      "cognia.diagnostic-service.connection.account-a",
      JSON.stringify({ ...connection, autoSubmit: undefined })
    )
    expect(loadDiagnosticConnection("account-a", deps)?.autoSubmit).toBe(false)
  })

  it("keeps the session token out of local storage entirely", async () => {
    const deps = memoryStores()
    saveDiagnosticConnection("account-a", connection, deps)
    await saveDiagnosticSessionToken("account-a", "session-jwt", deps)
    expect(JSON.stringify([...deps.localMap.values()])).not.toContain("session-jwt")
    await expect(loadDiagnosticSessionToken("account-a", deps)).resolves.toBe("session-jwt")
  })

  it("drops the secret before the record it belongs to", async () => {
    const deps = memoryStores()
    saveDiagnosticConnection("account-a", connection, deps)
    await saveDiagnosticSessionToken("account-a", "session-jwt", deps)
    await clearDiagnosticConnection("account-a", deps)
    expect(loadDiagnosticConnection("account-a", deps)).toBeNull()
    await expect(loadDiagnosticSessionToken("account-a", deps)).resolves.toBeNull()
  })
})

describe("DiagnosticGrantCache", () => {
  function cache(options: {
    now: () => number
    fetchImpl: DiagnosticFetch
    token?: string | null
  }) {
    return new DiagnosticGrantCache({
      connection,
      sessionToken: () => Promise.resolve(options.token === undefined ? "session" : options.token),
      fetchImpl: options.fetchImpl,
      now: options.now,
    })
  }

  function grantResponse(grant: string, expiresInSeconds = 900): Response {
    return new Response(JSON.stringify({ grant, role: "triager", expiresInSeconds }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  it("reuses a live grant and reports the role the service assigned", async () => {
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(() =>
      Promise.resolve(grantResponse("g1"))
    )
    const subject = cache({ now: () => 0, fetchImpl })
    expect(await subject.grant()).toBe("g1")
    expect(await subject.grant()).toBe("g1")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(subject.role).toBe("triager")
  })

  it("re-exchanges before expiry rather than at it", async () => {
    let now = 0
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(grantResponse("g1"))
      .mockResolvedValueOnce(grantResponse("g2"))
    const subject = cache({ now: () => now, fetchImpl })
    expect(await subject.grant()).toBe("g1")
    // 30s left: inside the refresh margin, so a request issued now cannot
    // arrive after the grant died.
    now = 870_000
    expect(await subject.grant()).toBe("g2")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("collapses concurrent callers onto a single exchange", async () => {
    let release: ((response: Response) => void) | undefined
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const subject = cache({ now: () => 0, fetchImpl })
    const pending = Promise.all([subject.grant(), subject.grant(), subject.grant()])
    // The exchange awaits the session token first, so `release` is only
    // assigned a microtask later — resolving before that would deadlock.
    await Promise.resolve()
    await Promise.resolve()
    release?.(grantResponse("g1"))
    await expect(pending).resolves.toEqual(["g1", "g1", "g1"])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("mints again after an invalidate, which is what a 401 triggers", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(grantResponse("g1"))
      .mockResolvedValueOnce(grantResponse("g2"))
    const subject = cache({ now: () => 0, fetchImpl })
    expect(await subject.grant()).toBe("g1")
    subject.invalidate()
    expect(await subject.grant()).toBe("g2")
  })

  it("fails with its own code when no session token has been stored", async () => {
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
    const subject = cache({ now: () => 0, fetchImpl, token: null })
    await expect(subject.grant()).rejects.toMatchObject({ code: "session_token_missing" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("does not cache a failed exchange, so the next call retries", async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "invalid_oidc_session" } }), { status: 401 })
      )
      .mockResolvedValueOnce(grantResponse("g1"))
    const subject = cache({ now: () => 0, fetchImpl })
    await expect(subject.grant()).rejects.toMatchObject({ code: "invalid_oidc_session" })
    expect(await subject.grant()).toBe("g1")
  })
})
