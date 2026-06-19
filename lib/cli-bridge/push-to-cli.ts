/**
 * Desktop → CLI push orchestrator (WS5).
 *
 * Runs the selected push operations against the cognia CLI home and returns a
 * per-item {@link PushReport}. Each item is isolated (one failure never aborts
 * the others). When there is no CLI home (web / unresolvable) the whole push is
 * a no-op and every requested item is reported `skipped`.
 *
 * MCP servers ride the existing agent-sync framework (`syncToAgent("cognia")`)
 * rather than a bespoke writer, so the cognia CLI shares the exact projection
 * logic every other agent uses.
 */

import type { AppSettings } from "@/lib/claude/types"
import { syncToAgent, type SyncResult } from "@/lib/claude/sync"

import { resolveCliHome } from "./home"
import { pushConfigToCli } from "./push-config"
import { pushCredentialsToCli } from "./push-credentials"
import { pushHistoryToCli } from "./push-history"

export interface PushToCliOptions {
  config?: boolean
  credentials?: boolean
  history?: boolean
  mcp?: boolean
}

export interface PushItemResult {
  ok: boolean
  /** True when the item was a no-op (nothing to write / not applicable). */
  skipped?: boolean
  /** Human-readable detail (count written, skip reason). */
  detail?: string
  error?: string
}

export interface PushReport {
  /** Resolved CLI home, or null when there is nothing to push to. */
  home: string | null
  config?: PushItemResult
  credentials?: PushItemResult
  history?: PushItemResult
  mcp?: PushItemResult
}

export interface PushToCliDeps {
  resolveHome?: () => Promise<string | null>
  pushConfig?: (settings: AppSettings) => Promise<boolean>
  pushCredentials?: (settings: AppSettings) => Promise<number>
  pushHistory?: () => Promise<number>
  syncMcp?: () => Promise<SyncResult>
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function mapSyncResult(result: SyncResult): PushItemResult {
  if (result.ok) return { ok: true, detail: `${result.count} server(s)` }
  if (result.skipped) return { ok: false, skipped: true, detail: result.reason }
  return { ok: false, error: result.error }
}

const ALL_ENABLED: Required<PushToCliOptions> = {
  config: true,
  credentials: true,
  history: true,
  mcp: true,
}

/**
 * Push the selected surfaces to the cognia CLI home. Defaults to pushing
 * everything. Never throws — failures land in the per-item report.
 */
export async function pushToCli(
  settings: AppSettings,
  options: PushToCliOptions = ALL_ENABLED,
  deps: PushToCliDeps = {}
): Promise<PushReport> {
  const home = await (deps.resolveHome ?? resolveCliHome)()
  const report: PushReport = { home }
  if (!home) {
    // No CLI home: report every requested item as skipped so the UI can explain.
    const skipped: PushItemResult = { ok: false, skipped: true, detail: "no-cli-home" }
    if (options.config) report.config = skipped
    if (options.credentials) report.credentials = skipped
    if (options.history) report.history = skipped
    if (options.mcp) report.mcp = skipped
    return report
  }

  if (options.config) {
    try {
      const ok = await (deps.pushConfig ?? pushConfigToCli)(settings)
      report.config = ok ? { ok: true } : { ok: false, skipped: true, detail: "no-cli-home" }
    } catch (err) {
      report.config = { ok: false, error: errMessage(err) }
    }
  }

  if (options.credentials) {
    try {
      const count = await (deps.pushCredentials ?? pushCredentialsToCli)(settings)
      report.credentials =
        count > 0
          ? { ok: true, detail: `${count} provider(s)` }
          : { ok: false, skipped: true, detail: "no-secrets" }
    } catch (err) {
      report.credentials = { ok: false, error: errMessage(err) }
    }
  }

  if (options.history) {
    try {
      const count = await (deps.pushHistory ?? pushHistoryToCli)()
      report.history =
        count > 0
          ? { ok: true, detail: `${count} entr(ies)` }
          : { ok: false, skipped: true, detail: "no-history" }
    } catch (err) {
      report.history = { ok: false, error: errMessage(err) }
    }
  }

  if (options.mcp) {
    try {
      const result = await (deps.syncMcp ?? (() => syncToAgent("cognia")))()
      report.mcp = mapSyncResult(result)
    } catch (err) {
      report.mcp = { ok: false, error: errMessage(err) }
    }
  }

  return report
}

/** Count of items that wrote successfully (for a toast summary). */
export function countPushSuccesses(report: PushReport): number {
  return [report.config, report.credentials, report.history, report.mcp].filter((r) => r?.ok).length
}

/** Count of items that errored (skips don't count). */
export function countPushErrors(report: PushReport): number {
  return [report.config, report.credentials, report.history, report.mcp].filter(
    (r) => r && !r.ok && !r.skipped
  ).length
}
