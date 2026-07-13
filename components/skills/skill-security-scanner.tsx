"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  RefreshCwIcon,
  ShieldIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { skillsScanResources, skillsScanSecurity, type SkillScanIssue } from "@/lib/claude/ipc"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { isTauri } from "@/lib/tauri"
import type { Skill } from "@/lib/claude/types"
import { loggers } from "@cognia/logging"

interface Props {
  skill: Skill
}

const SEVERITY_VARIANT: Record<
  SkillScanIssue["severity"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  high: "destructive",
  medium: "default",
  low: "secondary",
}

const SEVERITY_ICON: Record<SkillScanIssue["severity"], typeof AlertTriangleIcon> = {
  high: AlertCircleIcon,
  medium: AlertTriangleIcon,
  low: AlertTriangleIcon,
}

export function SkillSecurityScanner({ skill }: Props) {
  const t = useTranslations("skills.security")
  const tSeverity = (sev: SkillScanIssue["severity"]) => {
    if (sev === "high") return t("severityHigh")
    if (sev === "medium") return t("severityMedium")
    return t("severityLow")
  }
  const resources = useLiveQuery(() => listResourcesForSkill(skill.id), [skill.id])
  const [issues, setIssues] = useState<SkillScanIssue[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const desktop = isTauri()

  const runScan = async () => {
    if (!desktop) {
      setError(t("errorDesktopOnly"))
      return
    }
    setRunning(true)
    setError(null)
    try {
      const contentIssues = await skillsScanSecurity(skill.content)
      const resList: Array<[string, string]> = (resources ?? []).map((r) => [r.path, r.content])
      const resourceIssues = resList.length > 0 ? await skillsScanResources(resList) : []
      const all = [...contentIssues, ...resourceIssues]
      setIssues(all)
      loggers.skills.info("security scan ok", {
        skillId: skill.id,
        contentIssues: contentIssues.length,
        resourceIssues: resourceIssues.length,
        total: all.length,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      loggers.skills.error("security scan failed", err, { skillId: skill.id })
    } finally {
      setRunning(false)
    }
  }

  // Scan once on first mount when desktop. The user can re-run manually.
  useEffect(() => {
    if (desktop && issues === null && !running) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial scan trigger
      void runScan()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.id, resources?.length])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <ShieldIcon className="size-3.5" />
          {t("title")}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runScan()}
          disabled={running || !desktop}
        >
          {running ? (
            <Spinner className="mr-1.5 size-3" />
          ) : (
            <RefreshCwIcon className="mr-1.5 size-3.5" />
          )}
          {t("scan")}
        </Button>
      </div>

      {!desktop && (
        <Card className="p-3 text-xs text-muted-foreground">{t("desktopOnlyHint")}</Card>
      )}

      {error && (
        <Card className="border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </Card>
      )}

      {desktop &&
        issues !== null &&
        (issues.length === 0 ? (
          <Card className="flex items-center gap-2 p-3 text-xs">
            <CheckCircle2Icon className="size-4 text-emerald-500" />
            {t("noIssues")}
          </Card>
        ) : (
          <Card className="p-0">
            <div className="border-b px-3 py-2 text-xs font-medium">
              {t("issuesTitle", { count: issues.length })}
            </div>
            <ul className="divide-y">
              {issues.map((issue, i) => {
                const Icon = SEVERITY_ICON[issue.severity]
                return (
                  <li
                    key={`${issue.kind}-${i}`}
                    className="flex items-start gap-3 px-3 py-2 text-xs"
                  >
                    <Icon
                      className={
                        issue.severity === "high"
                          ? "size-4 shrink-0 text-destructive"
                          : "size-4 shrink-0 text-amber-500"
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {issue.message}
                        {issue.line !== undefined && (
                          <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                            :L{issue.line}
                          </span>
                        )}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{issue.kind}</p>
                    </div>
                    <Badge variant={SEVERITY_VARIANT[issue.severity]} className="h-5 text-[10px]">
                      {tSeverity(issue.severity)}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          </Card>
        ))}
    </div>
  )
}
