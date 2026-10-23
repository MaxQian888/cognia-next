// Switch execution: subscription readiness, settings persistence, sidecar update,
// then independently reported external-agent writes. Pure planning and matching
// live beside this module and are re-exported as the public interop surface.

import { restartSidecar, setProviderEnv } from "@/lib/claude/ipc"
import { getSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { writeClaudeSettingsEnv, writeOpencodeAuthEnv } from "./client"
import { buildProviderRegistration, canSwitchProvider } from "./provider"
import {
  activateSubscriptionForSwitch,
  type SubscriptionActivationResult,
} from "./subscription-switch"
import type { CcswitchAgentId, SwitchPlan } from "@/types/ccswitch"

export {
  buildProviderRegistration,
  canSwitchProvider,
  ccswitchProviderRefId,
  isOfficialClaudeProvider,
} from "./provider"
export { planSwitch } from "./switch-plan"
export { detectActive } from "./active-provider"
export type { SubscriptionActivationResult } from "./subscription-switch"

export interface ApplyResult {
  /** True iff cognia-next side committed (Dexie + sidecar). */
  cogniaApplied: boolean
  /** Per-agent outcomes. Failures don't abort; the user sees a partial result. */
  agentResults: Array<{
    agentId: CcswitchAgentId
    ok: boolean
    /** Path written, when ok. */
    path?: string
    /** Backup path that was created, when ok. */
    backupPath?: string
    /** Error message when not ok or skipped. */
    error?: string
  }>
  /**
   * Outcome of the subscription-activation step. Present only when the plan
   * targeted an official (OAuth) Claude provider (`useSubscription`).
   */
  subscription?: SubscriptionActivationResult
}

/**
 * Apply a plan. Order is deliberate: cognia-next first (cheap, reversible
 * — just a Dexie write + sidecar respawn), then per-agent writes (each
 * atomic but file-system-touching).
 */
export async function applySwitch(plan: SwitchPlan): Promise<ApplyResult> {
  if (!canSwitchProvider(plan.provider)) {
    throw new Error(
      "This CC Switch provider requires an unsupported protocol or managed authentication flow."
    )
  }
  const result: ApplyResult = {
    cogniaApplied: false,
    agentResults: [],
  }

  if (plan.cogniaChanges.useSubscription && isTauri()) {
    result.subscription = await activateSubscriptionForSwitch()
    if (!result.subscription.activated) return result
  }

  // Cognia-next: persist + push to sidecar. Registering the relay's models
  // needs the current provider map to merge the `anthropic` slot without
  // clobbering other providers, so read settings first.
  const current = await getSettings()
  const registration = buildProviderRegistration(plan.provider, {
    providerSettings: current?.providerSettings,
  })
  // Write through the settings store rather than calling `saveSettings`
  // directly. The store's `save` persists via the same Dexie path and then
  // re-seeds its in-memory `settings`, which is what every provider surface
  // renders from (Settings → Providers, the model picker). Persisting behind
  // the store's back left those latched on the pre-switch provider list until
  // an app reload, because `load()` early-returns once `loaded` is true.
  await useSettingsStore.getState().save({
    apiKey: plan.cogniaChanges.apiKeyAfter,
    apiBaseUrl: plan.cogniaChanges.baseUrlAfter,
    activeProviderId: plan.cogniaChanges.activeProviderIdAfter,
    ...(registration
      ? {
          providerSettings: registration.providerSettings,
          defaultProvider: registration.defaultProvider,
          defaultModel: registration.defaultModel,
        }
      : {}),
  })
  if (isTauri()) {
    // Always pass an explicit headers object so a switch to a provider without
    // headers clears a previous relay's (e.g. drops a stale 1M `anthropic-beta`).
    await setProviderEnv(
      plan.cogniaChanges.apiKeyAfter ?? null,
      plan.cogniaChanges.baseUrlAfter ?? null,
      registration?.customHeaders ?? {}
    )
    // Official (OAuth) Claude provider: activate the Anthropic subscription so
    // cognia doesn't end up keyless. `subscription_set_active` pushes the
    // bearer into the in-process env state and kills the sidecar itself, so
    // the restart below re-spawns with the bearer either way.
    if (plan.cogniaChanges.restartSidecar) {
      await restartSidecar()
    }
  }
  result.cogniaApplied = true

  // Per-agent: write the env patch via the appropriate IPC.
  for (const patch of plan.agentChanges) {
    if (patch.unsupported) {
      result.agentResults.push({
        agentId: patch.agentId,
        ok: false,
        error: patch.unsupportedReason,
      })
      continue
    }
    try {
      const updates: Record<string, string | null> = {}
      for (const u of patch.envUpdates) updates[u.key] = u.value
      switch (patch.agentId) {
        case "claude-code": {
          const out = await writeClaudeSettingsEnv(updates)
          result.agentResults.push({
            agentId: patch.agentId,
            ok: true,
            path: out.path,
            backupPath: out.backupPath,
          })
          break
        }
        case "opencode": {
          // opencode's `auth.json` — the Rust command writes a
          // `{ type: "api", key }` entry for the `__provider` carried in the
          // updates map.
          const out = await writeOpencodeAuthEnv(updates)
          result.agentResults.push({
            agentId: patch.agentId,
            ok: true,
            path: out.path,
            backupPath: out.backupPath,
          })
          break
        }
        default:
          // Should be unreachable — SUPPORTED_AGENTS gating in planSwitch
          // means we never get here with an unsupported id.
          result.agentResults.push({
            agentId: patch.agentId,
            ok: false,
            error: "unsupported agent",
          })
      }
    } catch (err) {
      result.agentResults.push({
        agentId: patch.agentId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
