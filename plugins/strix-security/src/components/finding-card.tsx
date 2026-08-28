"use client"

import { Bell, BellOff } from "lucide-react"
import { Badge } from "@cognia/plugin-ui"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import { FINDING_STATES, type FindingState, type Severity, type StrixFinding } from "../types"
import { usePluginT } from "../use-plugin-t"

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: "bg-red-600 text-white hover:bg-red-600",
  high: "bg-orange-500 text-white hover:bg-orange-500",
  medium: "bg-amber-500 text-black hover:bg-amber-500",
  low: "bg-yellow-400 text-black hover:bg-yellow-400",
  info: "bg-slate-400 text-white hover:bg-slate-400",
}

function Section({ title, text, code }: { title: string; text?: string; code?: string }) {
  if (!text && !code) return null
  return (
    <div className="mt-2">
      <h5 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h5>
      {text && <p className="mt-0.5 whitespace-pre-wrap text-sm">{text}</p>}
      {code && (
        <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

export interface FindingCardProps {
  finding: StrixFinding
  /** The recorded verdict. `open` when none was recorded. */
  state?: FindingState
  /** Muted, by verdict or by a rule covering its whole class. */
  suppressed?: boolean
  /** True when a suppression rule already covers this finding's class. */
  ruleMuted?: boolean
  onStateChange?: (state: FindingState) => void
  onSuppressRule?: () => void
  onUnsuppressRule?: () => void
}

export function FindingCard({
  finding,
  state = "open",
  suppressed = false,
  ruleMuted = false,
  onStateChange,
  onSuppressRule,
  onUnsuppressRule,
}: FindingCardProps) {
  const t = usePluginT()
  // A finding written before fingerprinting existed has no stable identity, so
  // a verdict recorded against it could not survive a rescan. Triage is hidden
  // rather than offered-and-silently-lost.
  const triageable = Boolean(finding.fingerprint) && Boolean(onStateChange)
  return (
    <div
      className={cn("rounded-md border p-3", suppressed && "opacity-60")}
      data-testid="strix-finding"
      data-severity={finding.severity}
      data-state={state}
      data-suppressed={suppressed ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-medium leading-snug">{finding.title}</h4>
        <div className="flex shrink-0 items-center gap-1.5">
          {suppressed && (
            <Badge variant="outline" className="gap-1" data-testid="strix-finding-suppressed">
              <BellOff className="size-3" />
              {t("triage.suppressed")}
            </Badge>
          )}
          <Badge className={cn("uppercase", SEVERITY_CLASS[finding.severity])}>
            {finding.severity}
          </Badge>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {finding.cvss != null && <span>{t("finding.cvss", { score: finding.cvss })}</span>}
        {finding.cwe && <span>{finding.cwe}</span>}
        {finding.cve && <span>{finding.cve}</span>}
        {finding.endpoint && (
          <span className="font-mono">
            {finding.method ? `${finding.method} ` : ""}
            {finding.endpoint}
          </span>
        )}
      </div>
      {finding.description && (
        <p className="mt-2 whitespace-pre-wrap text-sm">{finding.description}</p>
      )}
      <Section title={t("finding.impact")} text={finding.impact} />
      <Section title={t("finding.technical")} text={finding.technicalAnalysis} />
      <Section
        title={t("finding.poc")}
        text={finding.pocDescription}
        code={finding.pocScriptCode}
      />
      <Section title={t("finding.remediation")} text={finding.remediationSteps} />

      {triageable && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2">
          <label
            className="text-xs text-muted-foreground"
            htmlFor={`triage-${finding.fingerprint}`}
          >
            {t("triage.label")}
          </label>
          <select
            id={`triage-${finding.fingerprint}`}
            className="rounded-md border bg-background px-2 py-1 text-xs"
            value={state}
            onChange={(event) => onStateChange?.(event.target.value as FindingState)}
            data-testid="strix-finding-state"
          >
            {FINDING_STATES.map((value) => (
              <option key={value} value={value}>
                {t(`triage.state.${value}`)}
              </option>
            ))}
          </select>
          {finding.ruleId && onSuppressRule && !ruleMuted && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={onSuppressRule}
              data-testid="strix-suppress-rule"
            >
              <BellOff className="size-3" />
              {t("triage.muteRule", { rule: finding.ruleId })}
            </Button>
          )}
          {ruleMuted && (
            // A mute with no undo is a trap: the class disappears from the
            // gate and nothing on screen can bring it back.
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              onClick={onUnsuppressRule}
              disabled={!onUnsuppressRule}
              data-testid="strix-rule-muted"
            >
              <Bell className="size-3" />
              {t("triage.unmuteRule", { rule: finding.ruleId ?? "" })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
