/**
 * `/context` controller. The base report (estimated window + composition) is a
 * pure build; this controller additionally tries the SDK's live, authoritative
 * context breakdown via the renderer→sidecar control round-trip
 * (`getContextUsage`) and appends it when available.
 *
 * The SDK breakdown only exists on a live Anthropic session — any other path
 * (no session yet, ai-sdk provider) makes the control reject fast, so we fall
 * back to the estimate-only report. Never throws.
 */
import { getSessionContextUsage } from "@/lib/claude/ipc"
import type { SdkContextUsage } from "@cognia/agent-config-types"
import type { UsageInfo } from "@/lib/claude/adapter"

import { buildContextReport, formatSdkContextBreakdown } from "../commands/context-report"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"

export interface ContextReportDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  sessionId: string
  usage?: UsageInfo
  contextWindow?: number
  /** The launched executable preset — what the per-backend model memory is keyed
   * by, so the report names the model this backend actually runs. */
  presetId?: string
  /** SDK live-context fetch seam (tests); defaults to the IPC control round-trip. */
  fetchSdkContext?: (sessionId: string) => Promise<SdkContextUsage>
}

export async function runContextReport(deps: ContextReportDeps): Promise<void> {
  const base = buildContextReport(deps.usage, deps.config, deps.contextWindow, deps.presetId)

  let sdk: SdkContextUsage | null = null
  if (deps.sessionId) {
    const fetchSdk = deps.fetchSdkContext ?? getSessionContextUsage
    try {
      sdk = await fetchSdk(deps.sessionId)
    } catch {
      // No live Anthropic session (no_active_session / unsupported_provider /
      // timeout) — fall back to the estimate-only report.
      sdk = null
    }
  }

  const message = sdk ? `${base}\n${formatSdkContextBreakdown(sdk)}` : base
  deps.dispatch({ type: "NOTICE", message })
}
