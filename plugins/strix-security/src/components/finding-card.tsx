"use client"

import { Bell, BellOff, MapPin } from "lucide-react"
import { Badge } from "@cognia/plugin-ui"
import { Button } from "@cognia/plugin-ui"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import {
  FINDING_STATES,
  type CodeLocation,
  type FindingState,
  type Severity,
  type StrixFinding,
} from "../types"
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

/** `file:start–end` — the one-line form of a code location. */
function locationLine(location: CodeLocation): string {
  const file = location.file ?? ""
  if (location.startLine == null) return file
  const end = location.endLine != null ? `–${location.endLine}` : ""
  return `${file}:${location.startLine}${end}`
}

function CodeLocations({ locations }: { locations: CodeLocation[] }) {
  const t = usePluginT()
  if (locations.length === 0) return null
  return (
    <div className="mt-2" data-testid="strix-finding-locations">
      <h5 className="flex items-center gap-1 text-xs font-semibold uppercase text-muted-foreground">
        <MapPin className="size-3" />
        {t("finding.locations")}
      </h5>
      <ul className="mt-1 flex flex-col gap-1.5">
        {locations.map((location, i) => (
          <li key={`${locationLine(location)}:${i}`}>
            <div className="font-mono text-xs">
              {locationLine(location) || t("finding.locationUnknown")}
              {location.label && (
                <span className="ml-2 font-sans text-muted-foreground">{location.label}</span>
              )}
            </div>
            {location.snippet && (
              <pre className="mt-0.5 overflow-x-auto rounded bg-muted p-2 text-xs">
                <code>{location.snippet}</code>
              </pre>
            )}
          </li>
        ))}
      </ul>
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
          {state !== "open" && (
            <Badge variant="secondary" data-testid="strix-finding-state-badge">
              {t(`triage.state.${state}`)}
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
      <CodeLocations locations={finding.codeLocations ?? []} />
      <Section title={t("finding.remediation")} text={finding.remediationSteps} />

      {triageable && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2">
          <span className="text-xs text-muted-foreground">{t("triage.label")}</span>
          <Select value={state} onValueChange={(value) => onStateChange?.(value as FindingState)}>
            <SelectTrigger
              size="sm"
              className="w-auto min-w-28 gap-1 px-2 text-xs"
              aria-label={t("triage.label")}
              data-testid="strix-finding-state"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FINDING_STATES.map((value) => (
                <SelectItem key={value} value={value} className="text-xs">
                  {t(`triage.state.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
