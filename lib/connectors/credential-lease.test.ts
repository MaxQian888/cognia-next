const mockIssue = jest.fn()
const mockProfile = jest.fn()

jest.mock("@/lib/tauri/admin-lease", () => ({
  // The error CLASS stays real: this module distinguishes "the host is waiting
  // on a human" from every other refusal by identity, so a stubbed class would
  // silently collapse the two.
  ...jest.requireActual("@/lib/tauri/admin-lease"),
  issueHostAdminLease: (...args: unknown[]) => mockIssue(...args),
}))
jest.mock("@/lib/platform/capabilities", () => ({
  detectHostProfile: () => mockProfile(),
}))

import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"
import {
  CREDENTIAL_LEASE_OPERATIONS,
  DENIED_COOLDOWN_MS,
  PENDING_NO_CODE,
  __resetCredentialLeaseForTests,
  clearCredentialLease,
  credentialConsentCode,
  credentialLeaseRequired,
  ensureCredentialLease,
} from "./credential-lease"
import { connectorDeviceLease } from "./device-plane"

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  jest.clearAllMocks()
  __resetCredentialLeaseForTests()
  mockProfile.mockReturnValue("cloud-companion")
})

afterEach(() => {
  jest.useRealTimers()
  __resetCredentialLeaseForTests()
})

describe("credentialLeaseRequired", () => {
  it("is true only for the profiles whose keyring lives on a paired host", () => {
    expect(credentialLeaseRequired("cloud-companion")).toBe(true)
    expect(credentialLeaseRequired("mobile-companion")).toBe(true)
    expect(credentialLeaseRequired("desktop")).toBe(false)
    expect(credentialLeaseRequired("headless")).toBe(false)
    // No host to ask: minting would be a doomed round trip.
    expect(credentialLeaseRequired("web-standalone")).toBe(false)
  })
})

describe("ensureCredentialLease", () => {
  it("does not ask the host when the keyring is local", async () => {
    mockProfile.mockReturnValue("desktop")
    await expect(ensureCredentialLease()).resolves.toBe("not-required")
    expect(mockIssue).not.toHaveBeenCalled()
    expect(connectorDeviceLease()).toBeNull()
  })

  it("installs the token and covers all four keyring operations", async () => {
    mockIssue.mockResolvedValue({ token: "lease-1", operations: [], expiresAt: Date.now() + HOUR })

    await expect(ensureCredentialLease()).resolves.toBe("held")

    expect(connectorDeviceLease()).toBe("lease-1")
    expect(mockIssue).toHaveBeenCalledWith([
      "connectors_keyring_set",
      "connectors_keyring_get",
      "connectors_keyring_delete",
      "connectors_keyring_list",
    ])
    expect(CREDENTIAL_LEASE_OPERATIONS).toHaveLength(4)
  })

  it("reuses a live lease instead of prompting again", async () => {
    mockIssue.mockResolvedValue({ token: "lease-1", operations: [], expiresAt: Date.now() + HOUR })

    await ensureCredentialLease()
    await expect(ensureCredentialLease()).resolves.toBe("held")

    expect(mockIssue).toHaveBeenCalledTimes(1)
  })

  it("collapses concurrent callers onto one prompt", async () => {
    // Five credential reads start together on a Slack form; the operator must
    // be asked once, not five times.
    let release: (v: unknown) => void = () => {}
    mockIssue.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )

    const all = Promise.all([
      ensureCredentialLease(),
      ensureCredentialLease(),
      ensureCredentialLease(),
    ])
    release({ token: "lease-1", operations: [], expiresAt: Date.now() + HOUR })

    expect(await all).toEqual(["held", "held", "held"])
    expect(mockIssue).toHaveBeenCalledTimes(1)
  })

  it("re-asks once the lease is inside the renewal skew", async () => {
    mockIssue
      .mockResolvedValueOnce({ token: "old", operations: [], expiresAt: Date.now() + 5_000 })
      .mockResolvedValueOnce({ token: "new", operations: [], expiresAt: Date.now() + HOUR })

    await ensureCredentialLease()
    await expect(ensureCredentialLease()).resolves.toBe("held")

    expect(connectorDeviceLease()).toBe("new")
    expect(mockIssue).toHaveBeenCalledTimes(2)
  })

  it("treats an already-expired grant as a refusal", async () => {
    // A "yes" the cache would otherwise hold onto for a window that has
    // already closed, so every call under it fails at the gate.
    mockIssue.mockResolvedValue({ token: "stale", operations: [], expiresAt: Date.now() - 1 })

    await expect(ensureCredentialLease()).resolves.toBe("unavailable")
    expect(connectorDeviceLease()).toBeNull()
  })

  it("stops asking for a cooldown after a refusal", async () => {
    mockIssue.mockRejectedValue(new Error("REMOTE_CONSENT_REQUIRED"))

    await expect(ensureCredentialLease()).resolves.toBe("unavailable")
    await expect(ensureCredentialLease()).resolves.toBe("unavailable")

    expect(mockIssue).toHaveBeenCalledTimes(1)
    expect(connectorDeviceLease()).toBeNull()
  })

  it("asks again once the cooldown has elapsed", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    mockIssue.mockRejectedValueOnce(new Error("nope"))
    await ensureCredentialLease()

    jest.advanceTimersByTime(DENIED_COOLDOWN_MS + 1)
    mockIssue.mockResolvedValueOnce({
      token: "lease-2",
      operations: [],
      expiresAt: Date.now() + HOUR,
    })

    await expect(ensureCredentialLease()).resolves.toBe("held")
    expect(mockIssue).toHaveBeenCalledTimes(2)
  })
})

describe("clearCredentialLease", () => {
  it("drops the cooldown so an explicit retry asks immediately", async () => {
    mockIssue.mockRejectedValueOnce(new Error("nope"))
    await ensureCredentialLease()

    clearCredentialLease()
    mockIssue.mockResolvedValueOnce({
      token: "lease-3",
      operations: [],
      expiresAt: Date.now() + HOUR,
    })

    await expect(ensureCredentialLease()).resolves.toBe("held")
    expect(connectorDeviceLease()).toBe("lease-3")
  })

  it("drops a live token so the next call is unauthenticated rather than stale", async () => {
    mockIssue.mockResolvedValue({ token: "lease-4", operations: [], expiresAt: Date.now() + HOUR })
    await ensureCredentialLease()

    clearCredentialLease()

    expect(connectorDeviceLease()).toBeNull()
  })
})

describe("pending approval", () => {
  it("remembers the code the host is waiting on", async () => {
    mockIssue.mockRejectedValue(
      new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED: … (code A1B2C3D4)", "A1B2C3D4")
    )

    await expect(ensureCredentialLease()).resolves.toBe("unavailable")

    expect(credentialConsentCode()).toBe("A1B2C3D4")
  })

  it("still reports a pending approval when the host named no code", async () => {
    // "waiting on a human" and "refused outright" end differently, so they must
    // stay distinguishable even against a host older than ADR-0153.
    mockIssue.mockRejectedValue(new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", null))

    await ensureCredentialLease()

    expect(credentialConsentCode()).toBe(PENDING_NO_CODE)
  })

  it("reports no pending approval for an ordinary refusal", async () => {
    mockIssue.mockRejectedValue(new Error("REMOTE_SCOPE_DENIED: not a host admin"))

    await ensureCredentialLease()

    expect(credentialConsentCode()).toBeNull()
  })

  it("forgets the code once a lease is held", async () => {
    mockIssue.mockRejectedValueOnce(
      new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED: … (code ZZ)", "ZZ")
    )
    await ensureCredentialLease()
    clearCredentialLease()

    mockIssue.mockResolvedValueOnce({ token: "t", operations: [], expiresAt: Date.now() + HOUR })
    await ensureCredentialLease()

    expect(credentialConsentCode()).toBeNull()
  })

  it("forgets the code on an explicit retry", async () => {
    mockIssue.mockRejectedValue(
      new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED: … (code YY)", "YY")
    )
    await ensureCredentialLease()

    clearCredentialLease()

    expect(credentialConsentCode()).toBeNull()
  })
})
