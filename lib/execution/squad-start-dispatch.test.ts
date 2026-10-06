/** @jest-environment jsdom */
import { createSquadStartAttempt } from "./squad-start-dispatch"
import { HostConsentRequiredError, issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { startSquadRun } from "@/lib/ai/agent/team/squad/start-squad-run"
import type { HostProfile } from "@/lib/platform/capabilities"
import type { Transport } from "@/lib/tauri/transport-types"

jest.mock("@/lib/ai/agent/team/squad/start-squad-run", () => ({ startSquadRun: jest.fn() }))
jest.mock("@/lib/tauri/admin-lease", () => ({
  ...jest.requireActual("@/lib/tauri/admin-lease"),
  issueHostAdminLease: jest.fn(),
}))
const mockCall = jest.fn()
let mockRemote: Transport | null = null
let mockGeneration = 0
jest.mock("@/lib/tauri/transport-companion", () => ({
  getCompanionConfigGeneration: () => mockGeneration,
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({ getActiveRemoteTransport: () => mockRemote }))
const accepted = {
  started: true,
  runId: "host-run",
  executionRunId: "execution:team:host-run",
  squadName: "Review",
  duplicate: false,
}
const lease = jest.mocked(issueHostAdminLease)
const local = jest.mocked(startSquadRun)
beforeEach(() => {
  jest.clearAllMocks()
  mockRemote = null
  mockGeneration = 0
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  lease.mockResolvedValue({
    token: "lease-1",
    operations: ["team_run_start"],
    expiresAt: Date.now() + 120_000,
  })
  mockCall.mockResolvedValue(accepted)
  local.mockResolvedValue(accepted)
})

it("uses the existing local launcher with an interactive origin and the gesture id", async () => {
  const attempt = createSquadStartAttempt({
    teamId: "a",
    hostProfile: "desktop",
    goal: "Review",
    ultracode: true,
  })
  await expect(attempt.dispatch()).resolves.toEqual(accepted)
  expect(local).toHaveBeenCalledWith({
    squadId: "a",
    runId: attempt.launchId,
    goal: "Review",
    origin: "interactive",
    triggeredFrom: { source: "ui" },
    ultracode: true,
  })
  expect(lease).not.toHaveBeenCalled()
  expect(mockCall).not.toHaveBeenCalled()
})

it.each<HostProfile>(["mobile-companion", "cloud-companion", "desktop"])(
  "routes %s to the authoritative host without a local fallback",
  async (hostProfile) => {
    if (hostProfile === "desktop") mockRemote = { call: mockCall, subscribe: jest.fn() }
    const attempt = createSquadStartAttempt({ teamId: "a", hostProfile, ultracode: false })
    await expect(attempt.dispatch()).resolves.toEqual(accepted)
    expect(lease).toHaveBeenCalledWith(
      ["team_run_start"],
      120,
      mockRemote ?? jest.requireMock("@/lib/tauri/transport-instance").transport
    )
    expect(mockCall).toHaveBeenCalledWith(
      "team_run_start",
      { teamId: "a", launchId: attempt.launchId, ultracode: false, adminLease: "lease-1" },
      { idempotencyKey: expect.any(String) }
    )
    expect(local).not.toHaveBeenCalled()
  }
)

it("coalesces double taps and never dispatches an accepted gesture again", async () => {
  let finish!: (value: typeof accepted) => void
  mockCall.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const attempt = createSquadStartAttempt({ teamId: "a", hostProfile: "mobile-companion" })
  const first = attempt.dispatch()
  const second = attempt.dispatch()
  expect(first).toBe(second)
  await Promise.resolve()
  finish(accepted)
  await first
  await attempt.dispatch()
  expect(mockCall).toHaveBeenCalledTimes(1)
})

it("keeps the logical launch after a lost response but changes the transport key with a fresh lease", async () => {
  mockCall.mockRejectedValueOnce(new Error("response lost"))
  const attempt = createSquadStartAttempt({ teamId: "a", hostProfile: "mobile-companion" })
  await expect(attempt.dispatch()).resolves.toMatchObject({
    started: false,
    reason: "start_failed",
  })
  lease.mockResolvedValueOnce({
    token: "lease-2",
    operations: ["team_run_start"],
    expiresAt: Date.now() + 120_000,
  })
  mockCall.mockResolvedValueOnce({ ...accepted, duplicate: true })
  await expect(attempt.dispatch()).resolves.toMatchObject({ started: true, duplicate: true })
  expect(mockCall.mock.calls[0][1].launchId).toBe(mockCall.mock.calls[1][1].launchId)
  expect(mockCall.mock.calls[0][2].idempotencyKey).not.toBe(
    mockCall.mock.calls[1][2].idempotencyKey
  )
  expect(mockCall.mock.calls[1][1].adminLease).toBe("lease-2")
  expect(local).not.toHaveBeenCalled()
  expect(
    createSquadStartAttempt({ teamId: "a", hostProfile: "mobile-companion" }).launchId
  ).not.toBe(attempt.launchId)
})

it("keeps a consent retry tied to the original gesture", async () => {
  lease.mockRejectedValueOnce(new HostConsentRequiredError("ask host", "ABC123"))
  const attempt = createSquadStartAttempt({ teamId: "a", hostProfile: "cloud-companion" })
  await expect(attempt.dispatch()).resolves.toEqual({
    started: false,
    reason: "host_consent_required",
    consentCode: "ABC123",
  })
  expect(mockCall).not.toHaveBeenCalled()
  await attempt.dispatch()
  expect(mockCall.mock.calls[0][1].launchId).toBe(attempt.launchId)
})

it.each([
  ["interactive_approval_required", "approval_required"],
  ["permission_denied", "permission_denied"],
])("reports %s without dispatching locally", async (code, reason) => {
  mockCall.mockRejectedValueOnce(Object.assign(new Error(code), { code }))
  await expect(
    createSquadStartAttempt({ teamId: "a", hostProfile: "cloud-companion" }).dispatch()
  ).resolves.toEqual({ started: false, reason })
  expect(local).not.toHaveBeenCalled()
})

it("does not start or queue while offline and requires a new explicit retry after reconnect", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
  const attempt = createSquadStartAttempt({ teamId: "a", hostProfile: "mobile-companion" })
  await expect(attempt.dispatch()).resolves.toEqual({ started: false, reason: "offline" })
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  window.dispatchEvent(new Event("online"))
  await Promise.resolve()
  expect(lease).not.toHaveBeenCalled()
  expect(mockCall).not.toHaveBeenCalled()
})

it("does not send to a host selected while consent was being issued", async () => {
  lease.mockImplementationOnce(async () => {
    mockRemote = { call: mockCall, subscribe: jest.fn() }
    return { token: "lease", operations: ["team_run_start"], expiresAt: Date.now() + 120_000 }
  })
  await expect(
    createSquadStartAttempt({ teamId: "a", hostProfile: "cloud-companion" }).dispatch()
  ).resolves.toEqual({ started: false, reason: "host_changed" })
  expect(mockCall).not.toHaveBeenCalled()
})

it("preserves authoritative blockers and canonical live run IDs on a refusal", async () => {
  const refused = {
    ...accepted,
    started: false,
    reason: "already_running",
    blockers: [{ code: "environment_not_found" }],
  }
  mockCall.mockResolvedValueOnce(refused)
  await expect(
    createSquadStartAttempt({ teamId: "a", hostProfile: "cloud-companion" }).dispatch()
  ).resolves.toEqual(refused)
})

it.each([null, {}, { started: true }])(
  "refuses an incomplete host response %#",
  async (response) => {
    mockCall.mockResolvedValueOnce(response)
    await expect(
      createSquadStartAttempt({ teamId: "a", hostProfile: "cloud-companion" }).dispatch()
    ).resolves.toEqual({ started: false, reason: "start_failed" })
  }
)

it("refuses a retry after re-pairing the same Companion transport", async () => {
  lease.mockRejectedValueOnce(new HostConsentRequiredError("consent", "OLD"))
  const attempt = createSquadStartAttempt({ teamId: "a", hostProfile: "mobile-companion" })
  await attempt.dispatch()
  mockGeneration += 1
  await expect(attempt.dispatch()).resolves.toEqual({ started: false, reason: "host_changed" })
  expect(mockCall).not.toHaveBeenCalled()
  expect(lease).toHaveBeenCalledTimes(1)
})

it("issues the lease directly to the active remote when the desktop uses real RoutingTransport", async () => {
  const { RoutingTransport, setActiveRemoteTransport } = jest.requireActual(
    "@/lib/tauri/transport-routing"
  )
  const transportModule = jest.requireMock("@/lib/tauri/transport-instance")
  const original = transportModule.transport
  const localCall = jest.fn().mockRejectedValue(new Error("local must not run"))
  const remoteCall = jest
    .fn()
    .mockImplementation(async (command: string) =>
      command === "host_admin_lease_issue" ? { token: "remote-lease" } : accepted
    )
  const remoteTransport: Transport = { call: remoteCall, subscribe: jest.fn() }
  transportModule.transport = new RoutingTransport({ call: localCall, subscribe: jest.fn() })
  setActiveRemoteTransport(remoteTransport)
  mockRemote = remoteTransport
  lease.mockImplementationOnce(jest.requireActual("@/lib/tauri/admin-lease").issueHostAdminLease)
  try {
    await expect(
      createSquadStartAttempt({ teamId: "a", hostProfile: "desktop" }).dispatch()
    ).resolves.toEqual(accepted)
    expect(remoteCall.mock.calls.map((call) => call[0])).toEqual([
      "host_admin_lease_issue",
      "team_run_start",
    ])
    expect(localCall).not.toHaveBeenCalled()
  } finally {
    setActiveRemoteTransport(null)
    mockRemote = null
    transportModule.transport = original
  }
})
