"use client"

// What a cascade or panel run went through (ADR-0188 B3, D23): its roles, the
// phases it passed, the panel's candidates and judge, a cascade's escalation,
// a degraded answer, and what it cost. Shared by the answer's run card and the
// progress card of a run still in flight. The data is the plain summary the
// run's journal folds into; nothing a model wrote is in it.

import { useTranslations } from "next-intl"
import type { RouterFusionRunSummary } from "@cognia/agent-config-types"

/** Microusd as dollars: four decimals, or six when the amount is below a cent. */
export function formatMicrousd(amount: number): string {
  const usd = Math.max(0, amount) / 1_000_000
  return `$${usd.toFixed(amount > 0 && amount < 10_000 ? 6 : 4)}`
}

export const KNOWN_RUN_STATUSES = new Set([
  "queued",
  "running",
  "cancelling",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
])
export const KNOWN_COST_STATUSES = new Set(["actual", "estimated", "pending"])
export const KNOWN_ROLES = new Set([
  "solver",
  "reviewer",
  "cheap",
  "strong",
  "panel_a",
  "panel_b",
  "panel_c",
  "judge",
  "synthesizer",
  "lead",
  "worker",
])
export const KNOWN_PROFILES = new Set([
  "text_basic",
  "text_review",
  "schema_fixture",
  "evidence_review",
  "code_fixture",
])
const KNOWN_PHASES = new Set([
  "intake",
  "prepare",
  "cascade",
  "panel",
  "judge",
  "synthesis",
  "verification",
  "context",
  "execution",
])
const KNOWN_STEPS = new Set([
  "cheap",
  "strong",
  "escalate",
  "format_repair",
  "candidates",
  "member_tools",
  "reported",
  "verification_requests_left_open",
  "compacted",
  "invoke",
])
const KNOWN_REASONS = new Set([
  "FORMAT_INVALID",
  "VERIFICATION_FAILED",
  "VERIFICATION_INCONCLUSIVE",
  "FUSION_INSUFFICIENT_CANDIDATES",
])
const KNOWN_QUALITY = new Set(["accepted", "degraded", "unknown"])
const KNOWN_VERIFICATION_STATUSES = new Set(["passed", "failed", "inconclusive", "not_applicable"])
const KNOWN_LEVELS = new Set([
  "schema_only",
  "model_review",
  "tool_verified",
  "human_review",
  "mixed",
])

export function RunDetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  )
}

const warnText = "text-amber-600 dark:text-amber-400"

/** The words for a timeline entry: its step when this build knows it, else its phase, else both raw. */
export function useFusionPhaseText(): (phase: string, step: string | null) => string {
  const tFusion = useTranslations("routerFusion.runCard.fusion")
  return (phase, step) => {
    if (step && KNOWN_STEPS.has(step)) return tFusion(`step.${step}` as never)
    if (KNOWN_PHASES.has(phase)) return tFusion(`phase.${phase}` as never)
    return step ? `${phase} · ${step}` : phase
  }
}

export function FusionRunDetails({ summary }: { summary: RouterFusionRunSummary }) {
  const t = useTranslations("routerFusion.runCard")
  const tFusion = useTranslations("routerFusion.runCard.fusion")
  const tRefusal = useTranslations("routerFusion.refusal")
  const { timeline } = summary

  const known = (set: Set<string>, value: string, key: string, fallback: string) =>
    set.has(value) ? tFusion(`${key}.${value}` as never) : fallback
  const refusalText = (code: string) =>
    typeof tRefusal.has === "function" && tRefusal.has(code as never)
      ? tRefusal(code as never)
      : tRefusal("unknown", { code })
  const phaseText = useFusionPhaseText()
  const status = KNOWN_RUN_STATUSES.has(summary.status)
    ? t(`statusValue.${summary.status}` as never)
    : t("statusValue.unknown", { status: summary.status })
  const unknownCalls = timeline.calls.unknown

  return (
    <div data-testid="router-fusion-fusion-details">
      <dl className="space-y-1.5">
        <RunDetailRow label={t("status")}>{status}</RunDetailRow>
        {summary.errorCode ? (
          <RunDetailRow label={t("refused")}>
            <span className={warnText}>{refusalText(summary.errorCode)}</span>
          </RunDetailRow>
        ) : null}
        <RunDetailRow label={t("mode")}>
          {summary.mode === "panel" ? tFusion("modePanel") : tFusion("modeCascade")}
        </RunDetailRow>
        <RunDetailRow label={t("action")}>{summary.actionId}</RunDetailRow>
        <RunDetailRow label={t("rule")}>{summary.ruleId ?? t("ruleBaseline")}</RunDetailRow>
        {Object.entries(summary.roles).map(([role, deployment]) => (
          <RunDetailRow key={role} label={known(KNOWN_ROLES, role, "role", role)}>
            <span className="font-mono text-[10px]">{deployment}</span>
          </RunDetailRow>
        ))}
        {timeline.candidates.members !== null ? (
          <RunDetailRow label={tFusion("candidates")}>
            {tFusion("candidatesValue", {
              members: timeline.candidates.members,
              rejected: timeline.candidates.rejected,
              evidence: timeline.candidates.evidenceRejected,
            })}
          </RunDetailRow>
        ) : null}
        {timeline.judge ? (
          <RunDetailRow label={tFusion("judge")}>
            {tFusion("judgeValue", {
              supported: timeline.judge.supported,
              rejected: timeline.judge.rejected,
              unverified: timeline.judge.unverified,
            })}
            {timeline.judge.contradictions > 0 ? (
              <span className={`block ${timeline.judge.unresolved > 0 ? warnText : ""}`}>
                {tFusion("contradictions", {
                  count: timeline.judge.contradictions,
                  unresolved: timeline.judge.unresolved,
                })}
              </span>
            ) : null}
          </RunDetailRow>
        ) : null}
        {timeline.escalated ? (
          <RunDetailRow label={tFusion("escalated")}>
            {known(KNOWN_REASONS, timeline.escalated.reason, "reason", timeline.escalated.reason)}
          </RunDetailRow>
        ) : null}
        {timeline.degraded ? (
          <RunDetailRow label={tFusion("degraded")}>
            <span className={warnText}>
              {known(KNOWN_REASONS, timeline.degraded.reason, "reason", timeline.degraded.reason)}
            </span>
          </RunDetailRow>
        ) : null}
        {timeline.verification ? (
          <RunDetailRow label={tFusion("verification")}>
            {tFusion("verificationValue", {
              status: known(
                KNOWN_VERIFICATION_STATUSES,
                timeline.verification.status,
                "verificationStatus",
                timeline.verification.status
              ),
              level: known(
                KNOWN_LEVELS,
                timeline.verification.level,
                "level",
                timeline.verification.level
              ),
            })}
          </RunDetailRow>
        ) : null}
        {summary.qualityStatus ? (
          <RunDetailRow label={tFusion("quality")}>
            <span className={summary.qualityStatus === "accepted" ? "" : warnText}>
              {known(KNOWN_QUALITY, summary.qualityStatus, "qualityValue", summary.qualityStatus)}
            </span>
          </RunDetailRow>
        ) : null}
        <RunDetailRow label={t("cost")}>
          <span className="tabular-nums">
            {tFusion("costOfCap", {
              spent: formatMicrousd(summary.spentMicrousd),
              cap: formatMicrousd(summary.capMicrousd),
            })}
          </span>{" "}
          <span className="text-muted-foreground">
            {t("costStatusParenthesized", {
              status: KNOWN_COST_STATUSES.has(summary.costStatus)
                ? t(`costStatus.${summary.costStatus}` as never)
                : summary.costStatus,
            })}
          </span>
        </RunDetailRow>
        <RunDetailRow label={t("calls")}>
          {summary.modelCalls}
          {unknownCalls > 0 ? (
            <span className={`block ${warnText}`}>
              {tFusion("unknownCalls", { count: unknownCalls })}
            </span>
          ) : null}
        </RunDetailRow>
        {timeline.compactions > 0 ? (
          <RunDetailRow label={tFusion("compactions")}>{timeline.compactions}</RunDetailRow>
        ) : null}
        <RunDetailRow label={t("runId")}>
          <span className="font-mono text-[10px]">{summary.runId}</span>
        </RunDetailRow>
      </dl>
      {timeline.phases.length > 0 ? (
        <div className="mt-2">
          <p className="mb-1 text-muted-foreground">{tFusion("timeline")}</p>
          <ol className="space-y-0.5" data-testid="router-fusion-timeline">
            {timeline.phases.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={
                    index === timeline.phases.length - 1
                      ? "size-1.5 shrink-0 rounded-full bg-primary"
                      : "size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                  }
                />
                <span>{phaseText(entry.phase, entry.step)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}
