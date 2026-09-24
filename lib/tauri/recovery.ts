"use client"

import { invoke } from "@tauri-apps/api/core"

import {
  isRecoverySubsystem,
  type RecoveryBoot,
  type RecoveryStateV1,
  type RecoverySubsystem,
} from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import {
  isSecretStoreReadiness,
  type SecretStoreReadiness,
} from "@/lib/credentials/secret-store-readiness"

/**
 * Typed IPC for diagnostics-first safe mode (ADR-0102 §4).
 *
 * The renderer does not decide anything here — it reads decisions the native
 * controller already made and persisted. That split is the point: the previous
 * design put the state machine in the renderer, which is the process that dies
 * first, so the recovery path could never run when it was needed.
 *
 * Every function degrades to `null` off-desktop rather than throwing. Web and
 * mobile shells have no safe mode; callers branch on `null` and mount the
 * normal app.
 */

export const RECOVERY_BOOT_COMMAND = "recovery_boot_get"
export const RECOVERY_STATE_COMMAND = "recovery_state_get"
export const RECOVERY_CHECKPOINT_COMMAND = "recovery_checkpoint_record"
export const RECOVERY_RETRY_COMMAND = "recovery_retry"
export const RECOVERY_HEARTBEAT_COMMAND = "recovery_heartbeat"

export type RecoveryRetryAction = "retry" | "keep-disabled"

/**
 * The boot answer: the controller's decision plus the encrypted secret store's
 * settled state. The native side settles the store's *passive* initialization
 * (never a prompt) before answering, so a locked keychain is known at cold
 * boot instead of being discovered by the first credential consumer to fail.
 */
export interface RecoveryBootAnswer extends RecoveryBoot {
  secretStore: SecretStoreReadiness
}

/** Explicit, possibly interactive, secret-store retry on the sidecar group. */
const UNLOCK_SECRET_STORE_ACTION = "unlock-secret-store"

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    // A failed recovery call must never be the thing that stops the app from
    // booting. Report `null` — the caller treats that as "safe mode is not
    // available", which is the truthful answer when the controller is down.
    console.warn(`[recovery] ${command} failed`, error)
    return null
  }
}

/**
 * This session's boot decision. Read once, before plugin and background
 * initializers mount.
 */
export async function getRecoveryBoot(): Promise<RecoveryBootAnswer | null> {
  const answer = await call<RecoveryBoot & { secretStore?: unknown }>(RECOVERY_BOOT_COMMAND)
  if (!answer) return null
  return {
    ...answer,
    // An older native host omits the field; "uninitialized" means "unknown"
    // and never shows the locked notice.
    secretStore: isSecretStoreReadiness(answer.secretStore) ? answer.secretStore : "uninitialized",
  }
}

/** The full recovery state: checkpoints, suspect, budgets and audit history. */
export function getRecoveryState(): Promise<RecoveryStateV1 | null> {
  return call<RecoveryStateV1>(RECOVERY_STATE_COMMAND)
}

/**
 * Record the outcome of one subsystem's read-only health probe.
 *
 * `reasonCode` is a stable identifier, never display text: it is persisted,
 * audited and shown localized, so a sentence here would be an untranslatable
 * string in the operator's UI.
 */
export function recordRecoveryCheckpoint(
  subsystem: RecoverySubsystem,
  success: boolean,
  reasonCode?: string
): Promise<RecoveryStateV1 | null> {
  if (!isRecoverySubsystem(subsystem)) {
    return Promise.resolve(null)
  }
  return call<RecoveryStateV1>(RECOVERY_CHECKPOINT_COMMAND, {
    subsystem,
    success,
    reasonCode: reasonCode ?? null,
  })
}

/** Retry a subsystem, or accept keeping it disabled. Both outcomes are audited. */
export function retryRecoverySubsystem(
  subsystem: RecoverySubsystem,
  action: RecoveryRetryAction = "retry"
): Promise<RecoveryStateV1 | null> {
  if (!isRecoverySubsystem(subsystem)) {
    return Promise.resolve(null)
  }
  return call<RecoveryStateV1>(RECOVERY_RETRY_COMMAND, { subsystem, action })
}

/**
 * Explicitly retry the secret store's initialization. This is the only
 * renderer path that may show the OS keychain dialog, so it is reserved for a
 * user's Retry click. Unlike {@link retryRecoverySubsystem} it leaves every
 * checkpoint untouched and **rejects** on failure: the caller must be able to
 * tell "still locked" from "unlocked" to decide whether to re-run consumers.
 */
export async function unlockSecretStore(): Promise<RecoveryStateV1 | null> {
  if (!isTauri()) return null
  return invoke<RecoveryStateV1>(RECOVERY_RETRY_COMMAND, {
    subsystem: "sidecar",
    action: UNLOCK_SECRET_STORE_ACTION,
  })
}

/**
 * Report the renderer alive. The native healthy timer does not start without
 * this, so a session whose UI never painted is never counted as recovered.
 */
export function sendRecoveryHeartbeat(): Promise<RecoveryStateV1 | null> {
  return call<RecoveryStateV1>(RECOVERY_HEARTBEAT_COMMAND)
}

/**
 * Whether the safe-mode runtime is actually reachable on this host.
 *
 * Feeds `resolveCrashCapabilities({ safeModeRuntimeAvailable })`. A platform
 * that *could* host safe mode is not a platform that *has* it, and reporting
 * `supported` without this check is exactly how the matrix came to advertise a
 * recovery path that never fired.
 */
export async function isSafeModeRuntimeAvailable(): Promise<boolean> {
  if (!isTauri()) return false
  const boot = await getRecoveryBoot()
  return boot !== null
}
