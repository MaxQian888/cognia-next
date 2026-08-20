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
