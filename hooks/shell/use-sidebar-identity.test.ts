/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"

const readCloudSessionState = jest.fn()
jest.mock("@/lib/identity/cloud-session", () => ({
  readCloudSessionState: (...args: unknown[]) => readCloudSessionState(...args),
}))

const refresh = jest.fn(async () => {})
let snapshots: Array<{ meters: Array<{ usedPct: number | null }> }> = []
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useAllConfiguredLimits: () => ({ snapshots, refreshing: false, refresh }),
}))

jest.mock("@cognia/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }
  return { loggers: new Proxy({}, { get: () => stub }), createLogger: () => stub }
})

import { useSidebarIdentity } from "./use-sidebar-identity"

beforeEach(() => {
  readCloudSessionState.mockReset()
  refresh.mockClear()
  snapshots = []
  readCloudSessionState.mockResolvedValue({ status: "signed-out" })
})

describe("useSidebarIdentity", () => {
  it("reads the binding on mount, and leaves the usage aggregate until the menu opens", async () => {
    // The card's resting row renders the standing, so that read cannot wait for
    // an open. The usage number is only ever on screen inside the menu.
    renderHook(() => useSidebarIdentity(false))
    await waitFor(() => expect(readCloudSessionState).toHaveBeenCalledTimes(1))
    expect(refresh).not.toHaveBeenCalled()
  })

  it("a profile with no cloud binding stands on this device", async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useSidebarIdentity(active),
      { initialProps: { active: false } }
    )
    await waitFor(() => expect(readCloudSessionState).toHaveBeenCalledTimes(1))
    rerender({ active: true })
    expect(result.current.standing).toBe("local")
    expect(result.current.displayName).toBeNull()
    expect(result.current.needsReauth).toBe(false)
  })

  it("an offline session is still bound, and asks for no sign-in", async () => {
    readCloudSessionState.mockResolvedValue({
      status: "offline",
      sessionMetadata: { issuer: "i", clientId: "c", resource: "r", scopes: [] },
    })
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(result.current.standing).toBe("cloud"))
    // Patience, not a trip to Settings: the account is fine, the network is not.
    expect(result.current.needsReauth).toBe(false)
  })

  it("keeps an organization standing across a lapsed session, and asks to sign in", async () => {
    readCloudSessionState.mockResolvedValue({
      status: "reauth-required",
      reason: "expired",
      sessionMetadata: {
        issuer: "i",
        clientId: "c",
        resource: "r",
        scopes: [],
        organizationId: "logto_org_7",
      },
    })
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(result.current.standing).toBe("org"))
    expect(result.current.needsReauth).toBe(true)
  })

  it("falls back to local when a lapsed session left no metadata to name", async () => {
    readCloudSessionState.mockResolvedValue({
      status: "reauth-required",
      reason: "binding-missing",
      sessionMetadata: null,
    })
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(result.current.needsReauth).toBe(true))
    expect(result.current.standing).toBe("local")
  })

  it("a bound profile carries the cloud name and address", async () => {
    readCloudSessionState.mockResolvedValue({
      status: "active",
      session: {},
      identity: { userId: "usr_1", logtoSubject: "s", displayName: "Ada", email: "ada@x.dev" },
    })
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(result.current.displayName).toBe("Ada"))
    expect(result.current.email).toBe("ada@x.dev")
    expect(result.current.standing).toBe("cloud")
  })

  it("an organization-scoped session is its own standing", async () => {
    readCloudSessionState.mockResolvedValue({
      status: "active",
      session: {},
      identity: { userId: "usr_1", logtoSubject: "s", displayName: "Ada", orgId: "org_7" },
    })
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(result.current.standing).toBe("org"))
  })

  it("takes the worst meter across every account, rounded and clamped", async () => {
    snapshots = [{ meters: [{ usedPct: 12 }, { usedPct: null }] }, { meters: [{ usedPct: 44.6 }] }]
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(result.current.usagePercent).toBe(45)
  })

  it("reports no usage at all when nothing on the install is measured", async () => {
    snapshots = [{ meters: [{ usedPct: null }] }]
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(result.current.usagePercent).toBeNull()
  })

  it("a binding that cannot be read leaves the local reading standing", async () => {
    readCloudSessionState.mockRejectedValue(new Error("keyring locked"))
    const { result } = renderHook(() => useSidebarIdentity(true))
    await waitFor(() => expect(readCloudSessionState).toHaveBeenCalled())
    expect(result.current.standing).toBe("local")
    expect(result.current.displayName).toBeNull()
  })

  it("re-reads on each open, so a sign-in from Settings lands", async () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useSidebarIdentity(active),
      {
        initialProps: { active: true },
      }
    )
    await waitFor(() => expect(readCloudSessionState).toHaveBeenCalledTimes(1))
    rerender({ active: false })
    rerender({ active: true })
    await waitFor(() => expect(readCloudSessionState).toHaveBeenCalledTimes(2))
  })
})
