import { invoke } from "@tauri-apps/api/core"
import type {
  ProviderBalanceAmount,
  ProviderBalanceScriptSourceConfig,
} from "@cognia/provider-types"

import { isTauri } from "@/lib/tauri"

export interface BalanceScriptRunResult {
  sourceId: string
  amounts: ProviderBalanceAmount[]
  available?: boolean
  requestCount: number
}

export async function migrateProviderBalanceToken(
  sourceId: string,
  token: string
): Promise<string> {
  if (!isTauri()) throw new Error("Sandbox balance credentials require the desktop app")
  return invoke<string>("provider_diagnostics_migrate_balance_token", { sourceId, token })
}

export async function clearProviderBalanceToken(sourceId: string): Promise<void> {
  if (!isTauri()) throw new Error("Sandbox balance credentials require the desktop app")
  await invoke("provider_diagnostics_clear_balance_token", { sourceId })
}

export async function runProviderBalanceScript(
  source: ProviderBalanceScriptSourceConfig,
  providerMetadata: Record<string, unknown>
): Promise<BalanceScriptRunResult> {
  if (!isTauri()) throw new Error("Sandbox balance scripts require the desktop app")
  return invoke<BalanceScriptRunResult>("provider_diagnostics_run_balance_script", {
    request: {
      sourceId: source.id,
      script: source.script,
      providerMetadata,
      sameOrigin: source.sameOrigin,
      grants: source.grants,
    },
  })
}
