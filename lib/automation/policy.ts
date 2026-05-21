/**
 * ADR-0028 / T5 — per-action policy persistence + boot-time hydration.
 *
 * The Rust dispatcher (`src-tauri/src/automation/commands.rs::command_body!`)
 * runs the policy AFTER `PermissionGate::evaluate` resolves Allow for a
 * Computer Use action. Renderer-side responsibilities:
 *
 *   1. Hydrate `AutomationState.policy` from `AppSettings.automationPolicy`
 *      on boot — Rust starts the state empty.
 *   2. Push every edit through `automation_policy_set` so the next call
 *      sees the new constraints without restart.
 *   3. Mirror the saved policy back into `AppSettings` so writes survive
 *      app restarts.
 *
 * Empty policy = no extra constraint (today's behaviour).
 */

import { transport } from "@/lib/tauri"
import { isTauri } from "@/lib/tauri"
import { getSettings, saveSettings } from "@/lib/db/settings"

import type { AutomationPolicy } from "@/lib/claude/types"
import { DEFAULT_AUTOMATION_POLICY } from "@/lib/claude/types"

/** Fetch the policy currently held in Rust state. */
export async function getAutomationPolicy(): Promise<AutomationPolicy> {
  if (!isTauri()) return DEFAULT_AUTOMATION_POLICY
  const policy = await transport.call<AutomationPolicy>("automation_policy_get", {})
  return policy
}

/** Push a policy into Rust state. Persisted to AppSettings by `saveAutomationPolicy`. */
export async function setAutomationPolicy(policy: AutomationPolicy): Promise<void> {
  if (!isTauri()) return
  await transport.call<void>("automation_policy_set", { policy })
}

/**
 * Persist the policy: write to AppSettings (survives restart) AND push to
 * Rust state (takes effect on next call). Both writes happen — if the IPC
 * fails the settings write is rolled back so we don't show stale state.
 */
export async function saveAutomationPolicy(policy: AutomationPolicy): Promise<void> {
  const previous = (await getSettings()).automationPolicy
  await saveSettings({ automationPolicy: policy })
  try {
    await setAutomationPolicy(policy)
  } catch (err) {
    // Roll back the settings write so the next boot doesn't hydrate a
    // policy Rust never accepted.
    await saveSettings({ automationPolicy: previous })
    throw err
  }
}

/**
 * Hydrate Rust state from AppSettings. Called once on app boot from
 * `app/layout.tsx` (or equivalent bootstrap). Safe to call when Rust
 * already holds the same policy — `set` is idempotent.
 */
export async function hydrateAutomationPolicy(): Promise<void> {
  if (!isTauri()) return
  const settings = await getSettings()
  const policy = settings.automationPolicy ?? DEFAULT_AUTOMATION_POLICY
  await setAutomationPolicy(policy)
}
