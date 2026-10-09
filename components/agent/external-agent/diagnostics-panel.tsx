"use client"

/**
 * Runtime diagnostics for the agent selected in the External Agents dialog.
 *
 * Laid out as status tiles, then labelled rows, then a "what to do next"
 * callout. The panel used to be one grid of twenty "Label: value" sentences of
 * equal weight, where the line that mattered (is it blocked, and why) read the
 * same as the contract version.
 */

import { useCallback } from "react"
import { useLocale, useTranslations } from "next-intl"
import { AlertTriangle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { diagnosticCodeForReason } from "@/lib/diagnostics/external-agent-reason"
import type { ExternalAgentCapabilityProfileV1 } from "@cognia/agent-config-types/external-agent-capability"
import type {
  ExternalAgentConfig,
  ExternalAgentEcosystemReadinessSnapshot,
  ExternalAgentLastRunSnapshot,
  ExternalAgentSupportState,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import type { SessionObservationSummary } from "@/types/agent/agent-trace"
import { ExternalAgentCapabilityMatrix } from "./capability-matrix"
import { TraceHealthBadge } from "./trace-health-badge"

export interface ExternalAgentDiagnosticsPanelProps {
  config: ExternalAgentConfig
  capabilityProfile?: ExternalAgentCapabilityProfileV1
  validity?: ExternalAgentValiditySnapshot
  executable: boolean
  blockedReason: string | null
  ecosystem?: ExternalAgentEcosystemReadinessSnapshot
  activity: { richContentBlocks: number; compactionUpdates: number; nesSuggestions: number }
  lastRun?: ExternalAgentLastRunSnapshot | null
  lastRunHealth?: SessionObservationSummary | null
  className?: string
}

const SESSION_METHODS = [
  ["list", "session/list"],
  ["fork", "session/fork"],
  ["resume", "session/resume"],
] as const

/**
 * The snapshot type says `Date`, but a snapshot that went through persistence
 * or IPC arrives as an ISO string, and `String#toLocaleString` returns the
 * string unchanged — which is how a raw `2026-09-23T10:43:26.003Z` reached the
 * panel. Accept both.
 */
function formatTimestamp(value: Date | string, locale: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,34%)_minmax(0,1fr)] gap-3 py-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  )
}

function Tile({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  /** Second, smaller line — e.g. why the value is what it is. */
  detail?: string
  tone?: "ok" | "warn"
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "truncate text-base font-semibold",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400"
        )}
      >
        {value}
      </p>
      {detail && (
        <p className="line-clamp-2 text-[11px] text-muted-foreground" title={detail}>
          {detail}
        </p>
      )}
    </div>
  )
}

export function ExternalAgentDiagnosticsPanel({
  config,
  capabilityProfile,
  validity,
  executable,
  blockedReason,
  ecosystem,
  activity,
  lastRun,
  lastRunHealth,
  className,
}: ExternalAgentDiagnosticsPanelProps) {
  const t = useTranslations("externalAgent.manager.diagnostics")
  const tDiagnostics = useTranslations("diagnostics")
  const locale = useLocale()
  /**
   * Branch reason codes are machine identifiers (`ecosystem_prerequisite_missing`).
   * Resolve them through the shared diagnostic vocabulary; fall back to the raw
   * code so a reason code from a newer agent host degrades to the old
   * behaviour rather than to blank.
   */
  const reasonLabel = useCallback(
    (reasonCode: string): string => {
      const code = diagnosticCodeForReason(reasonCode)
      if (!code) return reasonCode
      const key = `code.${code}.label`
      return tDiagnostics.has(key) ? tDiagnostics(key) : reasonCode
    },
    [tDiagnostics]
  )
  const yesNo = (value: boolean) => (value ? t("yes") : t("no"))
  const supportLabel = (state: ExternalAgentSupportState | undefined) =>
    t(`supportState.${state ?? "unknown"}`)

  const reasonCode = validity?.canonicalReasonCode || validity?.lastBranchReasonCode || "ok"
  const reasonText =
    validity?.canonicalReason ||
    validity?.lastBranchReason ||
    blockedReason ||
    t("noBlockingReason")
  // `recoveryHints` are i18n key ids (see `canonical-contract.ts`), not prose.
  const recoveryHints = (validity?.recoveryHints ?? []).map((id) =>
    tDiagnostics.has(`recoveryHint.${id}`) ? tDiagnostics(`recoveryHint.${id}`) : id
  )
  // Entries are either a `{ id, params }` message reference this app generated
  // or prose persisted before that shape existed / supplied by a third-party
  // preset. Prose is shown as-is: there is no key to translate it by, and
  // dropping it would lose the only advice such a preset offers.
  const recommendedActions = (ecosystem?.recommendedActions ?? []).map((action) => {
    if (typeof action === "string") return action
    const key = `recommendedAction.${action.id}`
    return tDiagnostics.has(key) ? tDiagnostics(key, action.params ?? {}) : action.id
  })
  const correlationSession = validity?.correlation?.sessionId
  const correlationTurn = validity?.correlation?.turnId
  const authMethods = validity?.negotiation?.authMethods ?? []
  const hasNextSteps =
    Boolean(blockedReason) || recoveryHints.length > 0 || recommendedActions.length > 0

  return (
    <div className={cn("space-y-5", className)} data-testid="external-agent-diagnostics">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
        <Tile
          label={t("field.executable")}
          value={yesNo(executable)}
          detail={
            validity?.blockingReasonCode ? reasonLabel(validity.blockingReasonCode) : undefined
          }
          tone={executable ? "ok" : "warn"}
        />
        <Tile
          label={t("field.health")}
          value={validity?.healthStatus || t("unknown")}
          tone={
            validity?.healthStatus === "healthy"
              ? "ok"
              : validity?.healthStatus === "unhealthy"
                ? "warn"
                : undefined
          }
        />
        <Tile
          label={t("field.authRequired")}
          value={yesNo(Boolean(validity?.negotiation?.authRequired))}
        />
        <Tile
          label={t("field.lifecycleStage")}
          value={validity?.lifecycleStage || "config"}
          tone={validity?.blockedStage ? "warn" : undefined}
        />
      </div>

      {hasNextSteps && (
        <div role="note" className="space-y-1.5 border-l-2 border-amber-500/70 py-0.5 pl-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            {t("sectionNextSteps")}
          </p>
          {blockedReason && (
            <p>
              <span className="text-muted-foreground">{t("field.blockingReason")}: </span>
              {blockedReason}
            </p>
          )}
          {recoveryHints.length > 0 && (
            <div>
              <p className="text-muted-foreground">{t("field.recoveryHints")}</p>
              <ul className="ml-4 list-disc">
                {recoveryHints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>
          )}
          {recommendedActions.length > 0 && (
            <div>
              <p className="text-muted-foreground">{t("field.recommendedActions")}</p>
              <ul className="ml-4 list-disc">
                {recommendedActions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <Section title={t("sectionRuntime")}>
        <dl className="divide-y divide-border/60">
          <Row label={t("field.protocol")}>
            {t("protocolValue", {
              protocol: config.protocol.toUpperCase(),
              transport: config.transport,
            })}
          </Row>
          <Row label={t("field.sessionSupport")}>
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {SESSION_METHODS.map(([key, method]) => {
                const state = validity?.sessionExtensions?.[method]?.state
                return (
                  <span key={key} className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        state === "supported"
                          ? "bg-emerald-500"
                          : state === "unsupported"
                            ? "bg-amber-500"
                            : "bg-muted-foreground/40"
                      )}
                      aria-hidden
                    />
                    {t(`sessionMethod.${key}`)} · {supportLabel(state)}
                  </span>
                )
              })}
            </span>
          </Row>
          <Row label={t("field.authMethods")}>
            {authMethods.length ? authMethods.map((method) => method.id).join(", ") : t("none")}
          </Row>
          {ecosystem?.adapterName && <Row label={t("field.adapter")}>{ecosystem.adapterName}</Row>}
          {ecosystem?.surfaceName && <Row label={t("field.surface")}>{ecosystem.surfaceName}</Row>}
          {ecosystem?.supportTier && (
            <Row label={t("field.supportTier")}>{ecosystem.supportTier}</Row>
          )}
          {ecosystem?.prerequisiteStatus && (
            <Row label={t("field.prerequisites")}>{ecosystem.prerequisiteStatus}</Row>
          )}
          <Row label={t("field.acpActivity")}>
            {t("acpActivityValue", {
              rich: activity.richContentBlocks,
              compaction: activity.compactionUpdates,
              nes: activity.nesSuggestions,
            })}
          </Row>
        </dl>
      </Section>

      <Section title={t("sectionContract")}>
        <dl className="divide-y divide-border/60">
          <Row label={t("field.reason")}>
            {/* `ok` is the success path, not a reason worth a label of its own. */}
            {reasonCode === "ok"
              ? reasonText
              : t("reasonValue", { code: reasonLabel(reasonCode), reason: reasonText })}
          </Row>
          <Row label={t("field.contractVersion")}>{validity?.contractVersion ?? 1}</Row>
          <Row label={t("field.branchOutcome")}>{validity?.branchOutcome || "external"}</Row>
          {validity?.blockedStage && (
            <Row label={t("field.blockedStage")}>{validity.blockedStage}</Row>
          )}
          {(correlationSession || correlationTurn) && (
            <Row label={t("field.correlation")}>
              {t("correlationValue", {
                session: correlationSession || t("naLabel"),
                turn: correlationTurn || t("naLabel"),
              })}
            </Row>
          )}
        </dl>
      </Section>

      {lastRun && (
        <Section title={t("sectionLatestRun")}>
          <div className="space-y-1 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "font-medium",
                  lastRun.terminalOutcome === "error" && "text-destructive"
                )}
              >
                {t.has(`runOutcome.${lastRun.terminalOutcome}`)
                  ? t(`runOutcome.${lastRun.terminalOutcome}`)
                  : lastRun.terminalOutcome}
              </span>
              {lastRun.branchReasonCode !== "ok" && (
                <Badge variant="outline" className="text-[10px]">
                  {reasonLabel(lastRun.branchReasonCode)}
                </Badge>
              )}
              {lastRunHealth && <TraceHealthBadge summary={lastRunHealth} />}
              <span className="ml-auto text-muted-foreground">
                {formatTimestamp(lastRun.timestamp, locale)}
              </span>
            </div>
            {lastRun.diagnosticText && (
              <p className="text-muted-foreground">{lastRun.diagnosticText}</p>
            )}
            {lastRun.linkedTraceId && (
              <p className="truncate text-muted-foreground">
                {t("field.trace")}: <span className="font-mono">{lastRun.linkedTraceId}</span>
              </p>
            )}
            {lastRun.linkedSessionId && (
              <p className="truncate text-muted-foreground">
                {t("field.session")}:{" "}
                <span className="font-mono" title={lastRun.linkedSessionId}>
                  {lastRun.linkedSessionId}
                </span>
              </p>
            )}
          </div>
        </Section>
      )}

      {/* The merged capability answer, so a user whose /compact does nothing
          has somewhere to look. Same artifact the CLI and the execution
          resolver read — not a fourth reading of the preset. */}
      <Section title={t("sectionCapabilities")}>
        <ExternalAgentCapabilityMatrix profile={capabilityProfile} />
      </Section>
    </div>
  )
}
