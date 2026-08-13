import {
  ManagedControlChallengeRegistry,
  PERF_MANAGED_CHALLENGE_TTL_MS,
  managedProcessBusyKey,
  type ManagedControlChallengeRequest,
} from "./managed-control-challenges"
import type { ManagedProcess } from "./backend/types"

const process: ManagedProcess = {
  subsystem: "pluginHost",
  owner: "plugin:one",
  id: "worker",
  incarnation: "inc-1",
  name: "node",
  pid: 1,
  status: "running",
  canKill: true,
  canRestart: false,
  supportedActions: ["kill"],
  alive: true,
  detail: null,
}
const request: ManagedControlChallengeRequest = {
  deviceId: "device-a",
  targetId: "target-a",
  hostInstanceId: "host-a",
  routingGeneration: 4,
  owner: "plugin:one",
  id: "worker",
  incarnation: "inc-1",
  action: "kill",
  idempotencyKey: "action-a",
}

it("prepares a 60-second bound challenge and consumes it exactly once", async () => {
  let now = 100
  const dispatch = jest.fn().mockResolvedValue(undefined)
  const audit = jest.fn().mockResolvedValue(undefined)
  const registry = new ManagedControlChallengeRegistry({
    now: () => now,
    resolve: async (candidate) =>
      candidate.owner === process.owner && candidate.incarnation === process.incarnation
        ? process
        : null,
    hasRemoteControlGrant: async () => true,
    dispatch,
    audit,
  })
  const challenge = await registry.prepare(request)
  expect(challenge.expiresAt).toBe(now + PERF_MANAGED_CHALLENGE_TTL_MS)
  await expect(registry.prepare(request)).resolves.toEqual(challenge)
  await registry.execute(challenge.challengeId, "device-a")
  expect(dispatch).toHaveBeenCalledWith(process, "kill")
  await expect(registry.execute(challenge.challengeId, "device-a")).rejects.toThrow(
    "performance-managed-challenge-invalid"
  )
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "executed" }))
  now += PERF_MANAGED_CHALLENGE_TTL_MS
})

it("revalidates grant and owner incarnation at execute time", async () => {
  let granted = true
  let current: ManagedProcess | null = process
  const registry = new ManagedControlChallengeRegistry({
    now: () => 100,
    resolve: async () => current,
    hasRemoteControlGrant: async () => granted,
    dispatch: jest.fn(),
    audit: jest.fn(),
  })
  const revoked = await registry.prepare(request)
  granted = false
  await expect(registry.execute(revoked.challengeId, "device-a")).rejects.toThrow(
    "remote_control_forbidden"
  )
  granted = true
  const stale = await registry.prepare({ ...request, idempotencyKey: "action-b" })
  current = null
  await expect(registry.execute(stale.challengeId, "device-a")).rejects.toThrow(
    "performance-managed-owner-unavailable"
  )
})

it("keys busy state by owner, id, and incarnation", () => {
  expect(managedProcessBusyKey(process)).toBe("plugin:one:worker:inc-1")
  expect(managedProcessBusyKey({ ...process, incarnation: "inc-2" })).not.toBe(
    managedProcessBusyKey(process)
  )
})
