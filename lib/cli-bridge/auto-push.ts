/**
 * Auto-push gate (WS5). Pushes the desktop's config + credentials + input
 * history to the cognia CLI home when (a) we're on the Tauri desktop and (b)
 * the user enabled `cliBridge.autoSync`. Called on boot (a desktop coming
 * online IS the "online" trigger) and immediately when the toggle is switched
 * on. MCP servers are NOT auto-pushed here — they ride the per-server agent
 * sync chips so the user keeps explicit control over which servers leak to
 * which agent.
 */

import type { AppSettings } from "@/lib/claude/types"
import { isTauri } from "@/lib/tauri"

import { pushToCli, type PushReport } from "./push-to-cli"

export interface MaybeAutoPushDeps {
  isTauri?: () => boolean
  push?: typeof pushToCli
}

/**
 * Run the auto-push when enabled + on desktop. Returns the {@link PushReport},
 * or `null` when the push was skipped (web, or auto-sync off). Never throws —
 * `pushToCli` already isolates per-item failures.
 */
export async function maybeAutoPushToCli(
  settings: AppSettings,
  deps: MaybeAutoPushDeps = {}
): Promise<PushReport | null> {
  const tauri = deps.isTauri ?? isTauri
  if (!tauri()) return null
  if (!settings.cliBridge?.autoSync) return null
  const push = deps.push ?? pushToCli
  return push(settings, { config: true, credentials: true, history: true })
}
