import { act, renderHook, waitFor } from "@testing-library/react"

import type { StoredDiagnosticConnection } from "@/lib/diagnostic-service/connection"

const keyring = new Map<string, string>()
const localRecords = new Map<string, StoredDiagnosticConnection>()

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: "account-a" }),
}))

jest.mock("@/lib/diagnostic-service/connection", () => {
  const actual = jest.requireActual("@/lib/diagnostic-service/connection")
  return {
    ...actual,
    loadDiagnosticConnection: (accountId: string) => localRecords.get(accountId) ?? null,
    saveDiagnosticConnection: (accountId: string, record: StoredDiagnosticConnection) => {
      localRecords.set(accountId, record)
      return record
    },
    clearDiagnosticConnection: (accountId: string) => {
      localRecords.delete(accountId)
      keyring.delete(accountId)
      return Promise.resolve()
    },
    loadDiagnosticSessionToken: (accountId: string) =>
      Promise.resolve(keyring.get(accountId) ?? null),
    saveDiagnosticSessionToken: (accountId: string, token: string) => {
      keyring.set(accountId, token)
      return Promise.resolve()
    },
  }
})

import { useDiagnosticConnection } from "./use-diagnostic-connection"

const connection: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "tenant-1",
  projectId: "project-1",
  installationId: "install-1",
  autoSubmit: false,
  lastKnownRole: null,
}

const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()

beforeEach(() => {
  keyring.clear()
  localRecords.clear()
  fetchImpl.mockReset()
})

describe("useDiagnosticConnection", () => {
  it("reports unconfigured when nothing has been stored", async () => {
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connection).toBeNull()
    expect(result.current.client).toBeNull()
    expect(result.current.authenticated).toBe(false)
    expect(result.current.can("viewer")).toBe(false)
  })

  it("refuses to look connected when the keyring entry is gone", async () => {
    // A stored URL with a purged token renders a configured-looking panel that
    // fails on its first request — the exact trap `/servers` hit.
    localRecords.set("account-a", connection)
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connection).not.toBeNull()
    expect(result.current.authenticated).toBe(false)
    expect(result.current.client).toBeNull()
  })

  it("builds a client once both halves are present", async () => {
    localRecords.set("account-a", connection)
    keyring.set("account-a", "session-jwt")
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.authenticated).toBe(true))
    expect(result.current.client).not.toBeNull()
  })

  it("stores the token and the record when connecting", async () => {
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.connect({ ...connection, sessionToken: "session-jwt" })
    })
    expect(localRecords.get("account-a")?.baseUrl).toBe("https://diag.example.com")
    expect(keyring.get("account-a")).toBe("session-jwt")
    // The secret is never part of the persisted record.
    expect(JSON.stringify(localRecords.get("account-a"))).not.toContain("session-jwt")
    expect(result.current.authenticated).toBe(true)
  })

  it("drops both halves on disconnect", async () => {
    localRecords.set("account-a", connection)
    keyring.set("account-a", "session-jwt")
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.authenticated).toBe(true))
    await act(async () => {
      await result.current.disconnect()
    })
    expect(result.current.connection).toBeNull()
    expect(result.current.client).toBeNull()
    expect(keyring.has("account-a")).toBe(false)
  })

  it("gates surfaces on the role the service assigned", async () => {
    localRecords.set("account-a", { ...connection, lastKnownRole: "viewer" })
    keyring.set("account-a", "session-jwt")
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.role).toBe("viewer"))
    // A Viewer may read the console but may not triage or reach admin.
    expect(result.current.can("viewer")).toBe(true)
    expect(result.current.can("triager")).toBe(false)
    expect(result.current.can("admin")).toBe(false)
  })

  it("stays inert while no account is unlocked", async () => {
    localRecords.set("account-a", connection)
    keyring.set("account-a", "session-jwt")
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl, accountId: null }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connection).toBeNull()
    expect(result.current.client).toBeNull()
  })

  it("re-reads storage when another surface changed the connection", async () => {
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.connection).toBeNull()

    // The settings card wrote a connection while the console was mounted.
    localRecords.set("account-a", connection)
    keyring.set("account-a", "session-jwt")
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.authenticated).toBe(true))
  })
})

function grantResponse(role: string) {
  return new Response(JSON.stringify({ grant: "g", role, expiresInSeconds: 900 }), {
    status: 200,
  })
}

describe("useDiagnosticConnection role probe", () => {
  it("is unknown with nothing to ask", async () => {
    localRecords.set("account-a", connection)
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // No session token, so no client and no one to ask.
    expect(result.current.roleStatus).toBe("unknown")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("learns a null role from one grant exchange instead of reading it as 'below Viewer'", async () => {
    localRecords.set("account-a", connection)
    keyring.set("account-a", "session-jwt")
    fetchImpl.mockResolvedValue(grantResponse("viewer"))
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.authenticated).toBe(true))
    // Probing, not "insufficient": the console renders a loading state here.
    expect(["probing", "known"]).toContain(result.current.roleStatus)
    await waitFor(() => expect(result.current.roleStatus).toBe("known"))
    expect(result.current.role).toBe("viewer")
    expect(result.current.can("viewer")).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/v1/grants/oidc")
    // Remembered for the next session.
    expect(localRecords.get("account-a")?.lastKnownRole).toBe("viewer")
  })

  it("does not probe when a role is already remembered", async () => {
    localRecords.set("account-a", { ...connection, lastKnownRole: "triager" })
    keyring.set("account-a", "session-jwt")
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.roleStatus).toBe("known"))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reports a refused exchange with its code, and retries on demand", async () => {
    localRecords.set("account-a", connection)
    keyring.set("account-a", "session-jwt")
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "invalid_oidc_session" } }), { status: 401 })
    )
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.roleStatus).toBe("failed"))
    expect(result.current.roleErrorCode).toBe("invalid_oidc_session")
    expect(result.current.can("viewer")).toBe(false)

    fetchImpl.mockResolvedValueOnce(grantResponse("admin"))
    act(() => result.current.probeRole())
    await waitFor(() => expect(result.current.roleStatus).toBe("known"))
    expect(result.current.role).toBe("admin")
    expect(result.current.roleErrorCode).toBeNull()
  })

  it("forgets the old role when a new token is connected, and learns the new one", async () => {
    localRecords.set("account-a", { ...connection, lastKnownRole: "admin" })
    keyring.set("account-a", "old-jwt")
    const { result } = renderHook(() => useDiagnosticConnection({ fetchImpl }))
    await waitFor(() => expect(result.current.role).toBe("admin"))

    fetchImpl.mockResolvedValue(grantResponse("viewer"))
    await act(async () => {
      await result.current.connect({
        ...connection,
        lastKnownRole: "admin",
        sessionToken: "new-jwt",
      })
    })
    await waitFor(() => expect(result.current.role).toBe("viewer"))
    expect(result.current.roleStatus).toBe("known")
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body))
    expect(body.sessionToken).toBe("new-jwt")
  })
})
