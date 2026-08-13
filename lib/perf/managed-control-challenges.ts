import type { ManagedControlAction, ManagedProcess } from "./backend/types"

export const PERF_MANAGED_CHALLENGE_TTL_MS = 60_000

export interface ManagedControlChallengeRequest {
  deviceId: string
  targetId: string
  hostInstanceId: string
  routingGeneration: number
  owner: string
  id: string
  incarnation: string
  action: ManagedControlAction
  idempotencyKey: string
}

export interface ManagedControlChallenge extends ManagedControlChallengeRequest {
  challengeId: string
  expiresAt: number
}

export interface ManagedControlChallengeDependencies {
  now(): number
  resolve(request: ManagedControlChallengeRequest): Promise<ManagedProcess | null>
  hasRemoteControlGrant(deviceId: string): Promise<boolean>
  dispatch(process: ManagedProcess, action: ManagedControlAction): Promise<void>
  audit(input: {
    request: ManagedControlChallengeRequest
    outcome: "prepared" | "executed" | "denied" | "expired"
    detail?: string
  }): Promise<void>
}

function assertActionSupported(process: ManagedProcess, action: ManagedControlAction): void {
  const supported = process.supportedActions ?? [
    ...(process.canKill ? (["kill"] as const) : []),
    ...(process.canRestart ? (["restart"] as const) : []),
  ]
  if (process.alive === false || !supported.includes(action)) {
    throw new Error("performance-managed-action-unsupported")
  }
}

export class ManagedControlChallengeRegistry {
  private readonly challenges = new Map<string, ManagedControlChallenge>()
  private readonly idempotency = new Map<string, string>()

  constructor(private readonly dependencies: ManagedControlChallengeDependencies) {}

  async prepare(request: ManagedControlChallengeRequest): Promise<ManagedControlChallenge> {
    this.assertRequest(request)
    if (!(await this.dependencies.hasRemoteControlGrant(request.deviceId))) {
      await this.dependencies.audit({ request, outcome: "denied", detail: "remote-control-grant" })
      throw new Error("remote_control_forbidden")
    }
    const process = await this.dependencies.resolve(request)
    if (!process) {
      await this.dependencies.audit({ request, outcome: "denied", detail: "owner-unmounted" })
      throw new Error("performance-managed-owner-unavailable")
    }
    assertActionSupported(process, request.action)
    const key = `${request.deviceId}\u001f${request.idempotencyKey}`
    const existingId = this.idempotency.get(key)
    const existing = existingId ? this.challenges.get(existingId) : undefined
    if (existing && existing.expiresAt > this.dependencies.now()) return existing

    const challenge: ManagedControlChallenge = {
      ...request,
      challengeId: `perf-managed-${crypto.randomUUID()}`,
      expiresAt: this.dependencies.now() + PERF_MANAGED_CHALLENGE_TTL_MS,
    }
    this.challenges.set(challenge.challengeId, challenge)
    this.idempotency.set(key, challenge.challengeId)
    await this.dependencies.audit({ request, outcome: "prepared" })
    return challenge
  }

  async execute(challengeId: string, deviceId: string): Promise<void> {
    const challenge = this.challenges.get(challengeId)
    if (!challenge || challenge.deviceId !== deviceId) {
      throw new Error("performance-managed-challenge-invalid")
    }
    // Atomically consume before any async revalidation. Retry cannot replay it.
    this.challenges.delete(challengeId)
    this.idempotency.delete(`${challenge.deviceId}\u001f${challenge.idempotencyKey}`)
    if (challenge.expiresAt <= this.dependencies.now()) {
      await this.dependencies.audit({ request: challenge, outcome: "expired" })
      throw new Error("performance-managed-challenge-expired")
    }
    if (!(await this.dependencies.hasRemoteControlGrant(deviceId))) {
      await this.dependencies.audit({
        request: challenge,
        outcome: "denied",
        detail: "remote-control-grant-revoked",
      })
      throw new Error("remote_control_forbidden")
    }
    const process = await this.dependencies.resolve(challenge)
    if (!process) {
      await this.dependencies.audit({
        request: challenge,
        outcome: "denied",
        detail: "stale-owner",
      })
      throw new Error("performance-managed-owner-unavailable")
    }
    assertActionSupported(process, challenge.action)
    await this.dependencies.dispatch(process, challenge.action)
    await this.dependencies.audit({ request: challenge, outcome: "executed" })
  }

  private assertRequest(request: ManagedControlChallengeRequest): void {
    for (const [key, value] of Object.entries(request)) {
      if (typeof value === "string" && value.length === 0) {
        throw new Error(`performance-managed-${key}-required`)
      }
    }
    if (!Number.isSafeInteger(request.routingGeneration) || request.routingGeneration < 0) {
      throw new Error("performance-managed-routing-generation-invalid")
    }
  }
}

export function managedProcessBusyKey(
  process: Pick<ManagedProcess, "owner" | "subsystem" | "id" | "incarnation">
): string {
  return [process.owner ?? process.subsystem, process.id, process.incarnation ?? "unknown"].join(
    ":"
  )
}
