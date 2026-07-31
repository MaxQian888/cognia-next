import type { RuntimeSnapshot } from "./operation-availability"
import { resolveOperationAvailability } from "./operation-availability"
import type { RuntimeTarget } from "./runtime-target"

const standalone: RuntimeTarget = {
  id: "web-standalone",
  kind: "standalone",
  platform: "web",
}

const companion: RuntimeTarget = {
  id: "host-1",
  kind: "companion",
  platform: "web",
  hostKind: "cloud",
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    target: companion,
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: ["claude_send", "host_capabilities", "workflow_schedule_pause"],
      grants: ["agent.run", "host.observe", "workflow.run"],
    },
    ...overrides,
  }
}

describe("resolveOperationAvailability", () => {
  it("runs a browser-local executor in standalone mode", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ target: standalone, host: undefined }),
        command: "claude_send",
        localExecutorAvailable: true,
      })
    ).toEqual({ state: "available", reason: "local-executor" })
  })

  it("rejects host-only work in standalone mode", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ target: standalone, host: undefined }),
        command: "workflow_schedule_pause",
        localExecutorAvailable: false,
      })
    ).toEqual({ state: "unsupported", reason: "requires-companion" })
  })

  it("requires the Vault before a Companion operation can inspect credentials", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ vaultState: "locked" }),
        command: "claude_send",
      })
    ).toEqual({ state: "requires-unlock", reason: "vault-locked" })
  })

  it("fails closed for an incompatible or unadvertised host operation", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ host: { compatible: false, operations: [], grants: [] } }),
        command: "claude_send",
      })
    ).toEqual({ state: "incompatible", reason: "host-protocol" })

    expect(
      resolveOperationAvailability({
        snapshot: snapshot(),
        command: "session_attach",
        readOnlyFallback: true,
      })
    ).toEqual({ state: "read-only", reason: "operation-unavailable" })
  })

  it("distinguishes a missing device grant from an unsupported command", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({
          host: {
            compatible: true,
            operations: ["claude_send"],
            grants: ["host.observe"],
          },
        }),
        command: "claude_send",
      })
    ).toEqual({
      state: "requires-grant",
      reason: "missing-grant",
      requiredGrant: "agent.run",
    })
  })

  it("keeps cached reads available while a Companion is offline", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ connectionState: "offline" }),
        command: "host_capabilities",
        readOnlyFallback: true,
      })
    ).toEqual({ state: "read-only", reason: "offline-cache" })
  })

  it("queues only explicitly allowed low-risk idempotent writes", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ connectionState: "offline" }),
        command: "workflow_schedule_pause",
        offlineQueueAllowed: true,
      })
    ).toEqual({ state: "queued", reason: "offline-queue" })

    expect(
      resolveOperationAvailability({
        snapshot: snapshot({ connectionState: "offline" }),
        command: "claude_send",
        offlineQueueAllowed: false,
      })
    ).toEqual({ state: "offline", reason: "connection-offline" })
  })

  it("never routes service-only commands through a client target", () => {
    expect(
      resolveOperationAvailability({
        snapshot: snapshot({
          host: {
            compatible: true,
            operations: ["keyring_secret_get"],
            grants: ["service.internal"],
          },
        }),
        command: "keyring_secret_get",
      })
    ).toEqual({ state: "unsupported", reason: "service-only" })
  })
})
