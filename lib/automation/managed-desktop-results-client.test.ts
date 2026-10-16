jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: jest.fn(),
  getCompanionConfigGeneration: jest.fn(() => 0),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(),
  subscribeRuntimeTargetContext: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: jest.fn(),
  HostConsentRequiredError: class extends Error {},
}))
import { loadCompanionConfig, getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
jest.mock("@/lib/remote-host/management-channel", () => ({
  withManagementChannel: jest.fn(),
  acquireManagementChannel: jest.fn(),
}))
import { webcrypto } from "node:crypto"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { getState: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn() },
  transport: { call: jest.fn() },
  onTransportChange: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: jest.fn(),
  getActiveRemoteEndpoint: jest.fn(),
  subscribeActiveRemoteTransport: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/utils", () => ({ isTauri: jest.fn(() => true) }))
import { useAccountStore } from "@/stores/account/account-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import { getActiveRemoteTransport, getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import { isTauri } from "@/lib/utils"
import {
  createManagedDesktopResultsScope,
  managedDesktopEvidenceUrl,
  type ManagedDesktopEvidenceArtifact,
} from "./managed-desktop-results-client"

const remoteConfig = {
  accountId: "owner",
  deviceId: "device",
  baseUrl: "https://host.test",
  deviceKeyThumbprint: "key",
  serverFingerprint: "fingerprint",
}
const remoteEndpoint = { ...remoteConfig, remoteHost: { id: "host", label: "Host" } }
beforeEach(() => {
  jest.clearAllMocks()
  ;(localTransport.call as jest.Mock).mockReset()
  ;(transport.call as jest.Mock).mockReset()
  ;(getActiveRemoteEndpoint as jest.Mock).mockReturnValue(remoteEndpoint)
  ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
    hosts: [{ id: "host", config: remoteConfig }],
  })
  ;(getActiveRuntimeTargetContext as jest.Mock).mockReturnValue({
    accountId: "owner",
    targetId: "paired-host",
  })
  ;(loadCompanionConfig as jest.Mock).mockReturnValue({
    accountId: "owner",
    targetId: "paired-host",
    deviceId: "device",
  })
  ;(getCompanionConfigGeneration as jest.Mock).mockReturnValue(0)
  ;(isTauri as jest.Mock).mockReturnValue(true)
  ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(null)
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({
    unlockedAccountId: "owner",
    locked: false,
  })
})
test("history reads and approvals strip caller authority; no spending or capture API", async () => {
  const scope = createManagedDesktopResultsScope()
  await scope.list({ runId: "parent", ownerAccountId: "forged" } as { runId: string })
  await scope.approve("acceptance", 3, "approved", "request")
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_results_get_results",
    args: { runId: "parent" },
  })
  expect(localTransport.call).toHaveBeenLastCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_results_approve",
    args: {
      acceptanceId: "acceptance",
      expectedRevision: 3,
      decision: "approved",
      idempotencyKey: "request",
    },
  })
  expect(Object.keys(scope).sort()).toEqual(
    ["approve", "assertActive", "dispose", "get", "list", "owner", "readEvidence"].sort()
  )
  scope.dispose()
})
test("uses the selected remote or owner-matching paired headless transport with no local fallback", async () => {
  const remote = { call: jest.fn().mockResolvedValue([]) }
  ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(remote)
  const scope = createManagedDesktopResultsScope()
  await scope.list({ taskId: "task" })
  expect(remote.call).toHaveBeenCalledWith("managed_desktop_results_get_results", {
    taskId: "task",
  })
  expect(localTransport.call).not.toHaveBeenCalled()
  scope.dispose()
  ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(null)
  ;(isTauri as jest.Mock).mockReturnValue(false)
  const headless = createManagedDesktopResultsScope()
  await headless.get("id")
  expect(transport.call).toHaveBeenCalledWith("managed_desktop_results_get_result", {
    acceptanceId: "id",
  })
  await headless.approve("id", 0, "approved", "approval")
  expect(transport.call).toHaveBeenLastCalledWith("managed_desktop_results_approve", {
    acceptanceId: "id",
    expectedRevision: 0,
    decision: "approved",
    idempotencyKey: "approval",
  })
  headless.dispose()
})
test("account changes revoke visible scope and discard pending bytes even after switching back", async () => {
  const invalidated = jest.fn()
  const scope = createManagedDesktopResultsScope(invalidated)
  ;(localTransport.call as jest.Mock).mockImplementation(async () => {
    ;(useAccountStore.getState as jest.Mock).mockReturnValue({
      unlockedAccountId: "other",
      locked: false,
    })
    ;(useAccountStore.subscribe as jest.Mock).mock.calls[0][0]()
    ;(useAccountStore.getState as jest.Mock).mockReturnValue({
      unlockedAccountId: "owner",
      locked: false,
    })
    return { base64: "private" }
  })
  await expect(scope.readEvidence("a", "image")).rejects.toThrow("session_invalidated")
  expect(invalidated).toHaveBeenCalledTimes(1)
  expect(() => scope.assertActive()).toThrow("session_invalidated")
  scope.dispose()
})
test("rejects unauthenticated scope before any transport call", () => {
  ;(useAccountStore.getState as jest.Mock).mockReturnValue({ locked: true })
  expect(() => createManagedDesktopResultsScope()).toThrow("authentication_required")
  expect(localTransport.call).not.toHaveBeenCalled()
})

describe("private image URLs", () => {
  const artifact: ManagedDesktopEvidenceArtifact = {
    id: "a",
    criterionId: "c",
    kind: "checkpoint",
    mimeType: "image/png",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    bytes: 3,
    width: 1,
    height: 1,
    capturedAt: 1,
  }
  beforeEach(() => {
    Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle, configurable: true })
    URL.createObjectURL = jest.fn(() => "blob:private")
  })
  test("creates an ephemeral URL only for bounded hash-matching no-store bytes", async () => {
    await expect(
      managedDesktopEvidenceUrl(artifact, {
        mimeType: "image/png",
        sha256: artifact.sha256,
        cacheControl: "no-store",
        base64: "YWJj",
      })
    ).resolves.toBe("blob:private")
  })
  test.each([
    { mimeType: "image/svg+xml" },
    { cacheControl: "public" },
    { base64: "YWJk" },
    { sha256: "0".repeat(64) },
    { base64: "YQ==" },
  ])("rejects changed evidence %o", async (override) => {
    await expect(
      managedDesktopEvidenceUrl(artifact, {
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        cacheControl: "no-store",
        base64: "YWJj",
        ...override,
      } as Parameters<typeof managedDesktopEvidenceUrl>[1])
    ).rejects.toThrow()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

test.each([undefined, "previous-owner"])(
  "refuses a previous-account active endpoint (%s) before reading or approving",
  (accountId) => {
    const remote = { call: jest.fn() }
    ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(remote)
    ;(getActiveRemoteEndpoint as jest.Mock).mockReturnValue({
      accountId,
      remoteHost: { id: "host" },
      deviceId: "device",
    })
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
      hosts: [{ id: "host", config: { accountId, deviceId: "device" } }],
    })
    expect(() => createManagedDesktopResultsScope()).toThrow("session_invalidated")
    expect(remote.call).not.toHaveBeenCalled()
  }
)

test.each([undefined, "previous-owner"])(
  "rejects registered Host config ownership %s even if endpoint claims current owner",
  (accountId) => {
    const remote = { call: jest.fn() }
    ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(remote)
    ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
      hosts: [{ id: "host", config: { ...remoteConfig, accountId } }],
    })
    expect(() => createManagedDesktopResultsScope()).toThrow("session_invalidated")
    expect(remote.call).not.toHaveBeenCalled()
  }
)

test("rejects an old active device transport after the Host row was re-paired", () => {
  const remote = { call: jest.fn() }
  ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(remote)
  ;(getActiveRemoteEndpoint as jest.Mock).mockReturnValue({
    ...remoteEndpoint,
    deviceId: "old-device",
  })
  expect(() => createManagedDesktopResultsScope()).toThrow("session_invalidated")
  expect(remote.call).not.toHaveBeenCalled()
})

test("Host pairing ABA drops pending private bytes and forbids later approval", async () => {
  const remote = {
    call: jest.fn().mockImplementation(async () => {
      ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
        hosts: [{ id: "host", config: { ...remoteConfig, accountId: "other" } }],
      })
      for (const [notify] of (useRemoteHostStore.subscribe as jest.Mock).mock.calls) notify()
      ;(useRemoteHostStore.getState as jest.Mock).mockReturnValue({
        hosts: [{ id: "host", config: remoteConfig }],
      })
      for (const [notify] of (useRemoteHostStore.subscribe as jest.Mock).mock.calls) notify()
      return { base64: "private" }
    }),
  }
  ;(getActiveRemoteTransport as jest.Mock).mockReturnValue(remote)
  const invalidated = jest.fn()
  const scope = createManagedDesktopResultsScope(invalidated)
  await expect(scope.readEvidence("acceptance", "image")).rejects.toThrow("session_invalidated")
  await expect(scope.approve("acceptance", 1, "approved", "operation")).rejects.toThrow(
    "session_invalidated"
  )
  expect(remote.call).toHaveBeenCalledTimes(1)
  expect(invalidated).toHaveBeenCalledTimes(1)
  scope.dispose()
})

test.each([undefined, "previous-owner"])(
  "headless paired transport cannot use stale config ownership %s",
  (accountId) => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    ;(loadCompanionConfig as jest.Mock).mockReturnValue({
      accountId,
      targetId: "paired-host",
      deviceId: "device",
    })
    expect(() => createManagedDesktopResultsScope()).toThrow("session_invalidated")
    expect(transport.call).not.toHaveBeenCalled()
  }
)

test("paired target generation change cannot resume a private result scope after returning", async () => {
  ;(isTauri as jest.Mock).mockReturnValue(false)
  const scope = createManagedDesktopResultsScope()
  ;(getCompanionConfigGeneration as jest.Mock).mockReturnValue(1)
  for (const [notify] of (subscribeRuntimeTargetContext as jest.Mock).mock.calls) notify()
  ;(getCompanionConfigGeneration as jest.Mock).mockReturnValue(0)
  await expect(scope.get("acceptance")).rejects.toThrow("session_invalidated")
  expect(transport.call).not.toHaveBeenCalled()
  scope.dispose()
})
