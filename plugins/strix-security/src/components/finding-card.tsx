"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Severity, StrixFinding } from "../types"
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

export function FindingCard({ finding }: { finding: StrixFinding }) {
  const t = usePluginT()
  return (
    <div
      className="rounded-md border p-3"
      data-testid="strix-finding"
      data-severity={finding.severity}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-medium leading-snug">{finding.title}</h4>
        <Badge className={cn("shrink-0 uppercase", SEVERITY_CLASS[finding.severity])}>
          {finding.severity}
        </Badge>
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
    </div>
  )
}
