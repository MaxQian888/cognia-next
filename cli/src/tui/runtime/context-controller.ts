/** Open a detailed snapshot, with a bounded optional live SDK breakdown. */
import { getSessionContextUsage } from "@/lib/claude/ipc"
import type { SdkContextUsage } from "@cognia/agent-config-types"
import type { UsageInfo } from "@/lib/claude/adapter"

import { buildContextReport, formatSdkContextBreakdown } from "../commands/context-report"
import type { ResolvedConfig } from "../../config/schema"
import { createCliTranslator } from "../i18n"
import { backendIdentity } from "./backend-identity"
import type { TuiAction } from "../state/types"

export interface ContextReportDeps {
  /** Suppress late results and new work after the runtime request is cancelled. */
  signal?: AbortSignal
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  sessionId: string
  usage?: UsageInfo
  contextWindow?: number
  /** The launched executable preset — what the per-backend model memory is keyed
   * by, so the report names the model this backend actually runs. */
  presetId?: string
  /** SDK live-context fetch seam (tests); defaults to the IPC control round-trip. */
  /** Bound the optional live read so a missing backend cannot hold the report open. */
  timeoutMs?: number
  fetchSdkContext?: (sessionId: string) => Promise<SdkContextUsage>
}

export async function runContextReport(deps: ContextReportDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const t = createCliTranslator(deps.config.locale, "cliUiContext")
  const base = buildContextReport(deps.usage, deps.config, deps.contextWindow, deps.presetId)
  const identity = backendIdentity(deps.config, deps.presetId)
  let sdk: SdkContextUsage | null = null
  let status = !deps.sessionId ? "noSession" : "unsupported"
  if (deps.sessionId && !identity.external && deps.config.provider === "anthropic") {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    status = "unavailable"
    try {
      const fallback = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          status = "timeout"
          resolve(null)
        }, deps.timeoutMs ?? 2000)
        onAbort = () => resolve(null)
        deps.signal?.addEventListener("abort", onAbort, { once: true })
      })
      sdk = await Promise.race([
        Promise.resolve().then(() =>
          deps.signal?.aborted
            ? null
            : (deps.fetchSdkContext ?? getSessionContextUsage)(deps.sessionId)
        ),
        fallback,
      ])
    } catch {
      // Keep the local snapshot usable even when the live SDK read fails.
      sdk = null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) deps.signal?.removeEventListener("abort", onAbort)
    }
  }
  if (deps.signal?.aborted) return
  const body = [
    t("controller.snapshot", { time: new Date().toISOString() }),
    ...(sdk ? [formatSdkContextBreakdown(sdk, deps.config.locale)] : [t(`controller.${status}`)]),
    base,
    t("controller.help"),
  ].join("\n\n")
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "document", title: t("controller.title"), body, format: "markdown" },
  })
}
