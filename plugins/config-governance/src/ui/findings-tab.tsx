"use client"

import { useMemo, useState } from "react"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import {
  Badge,
  Button,
  Checkbox,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cognia/plugin-ui"

import { renderHunk } from "../engine/diff"
import type { Finding, FindingGroup, Hunk } from "../model"
import { PLUGIN_ID } from "../model"
import type { SurfaceApplyResult } from "../runtime/apply"
import { hasPromptCenterEntry, type GovernanceRuntime } from "../runtime/runtime"
import { GROUPS } from "../runtime/store"
import { act } from "./act"
import { DiffView } from "./diff-view"
import { lineRange } from "./format"
import type { GovernanceData } from "./use-governance"

type GroupFilter = FindingGroup | "all"

export interface FindingsTabProps {
  runtime: GovernanceRuntime
  workspaceId: string | null
  data: GovernanceData
  busy: boolean
}

/** Findings whose hunks "select all" may take: not proposed-only, not kept. */
export function selectableByDefault(
  findings: readonly Finding[],
  hunks: readonly Hunk[],
  kept: ReadonlySet<string>
): string[] {
  const withHunks = new Set(
    hunks.filter((hunk) => !hunk.proposedOnly).map((hunk) => hunk.findingId)
  )
  return findings
    .filter((finding) => withHunks.has(finding.id) && !kept.has(finding.id))
    .map((finding) => finding.id)
}

export function FindingsTab({ runtime, workspaceId, data, busy }: FindingsTabProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const [group, setGroup] = useState<GroupFilter>("all")
  const [showKept, setShowKept] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<SurfaceApplyResult[] | null>(null)
  const [enforcing, setEnforcing] = useState<string | null>(null)

  const hunks = useMemo(() => data.run?.hunks ?? [], [data.run])
  const hunksByFinding = useMemo(() => {
    const map = new Map<string, Hunk[]>()
    for (const hunk of hunks) map.set(hunk.findingId, [...(map.get(hunk.findingId) ?? []), hunk])
    return map
  }, [hunks])
  const names = useMemo(() => {
    const map = new Map(
      (data.run?.surfaces ?? []).map((entry) => [entry.surface.key, entry.surface.name])
    )
    for (const check of data.checksById.values())
      map.set(check.rule.surfaceKey, check.rule.surfaceName)
    return map
  }, [data.run, data.checksById])

  const visible = data.findings.filter(
    (finding) =>
      (group === "all" || finding.group === group) && (showKept || !data.kept.has(finding.id))
  )

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const apply = () =>
    act(
      runtime.apply(workspaceId, selected).then((next) => {
        setResults(next)
        setSelected(new Set())
      }),
      t
    )

  if (!data.run && data.findings.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">{t("findings.none")}</p>
  }

  return (
    <div className="space-y-3 p-3" data-testid="governance-findings">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={group} onValueChange={(value) => setGroup(value as GroupFilter)}>
          <SelectTrigger className="h-7 w-44 text-xs" aria-label={t("findings.filterGroup")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("group.all")}</SelectItem>
            {GROUPS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(`group.${entry}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="governance-show-kept"
            checked={showKept}
            onCheckedChange={(value) => setShowKept(value === true)}
          />
          <Label htmlFor="governance-show-kept" className="text-xs">
            {t("findings.showKept", { count: data.kept.size })}
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setSelected(new Set(selectableByDefault(visible, hunks, data.kept)))}
          >
            {t("findings.selectSafe")}
          </Button>
          <Button type="button" size="sm" disabled={busy || selected.size === 0} onClick={apply}>
            {t("findings.apply", { count: selected.size })}
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("findings.applyHint")}</p>

      {results && (
        <ul
          className="space-y-1 rounded-md border p-2 text-xs"
          data-testid="governance-apply-results"
        >
          {results.map((result) => (
            <li key={result.surfaceKey}>
              {t(`applyStatus.${result.status}`, {
                name: names.get(result.surfaceKey) ?? result.surfaceKey,
                count: result.hunks,
              })}
              {result.error ? ` — ${result.error}` : ""}
            </li>
          ))}
        </ul>
      )}

      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("findings.noneInFilter")}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((finding) => {
            const ownHunks = hunksByFinding.get(finding.id) ?? []
            const kept = data.kept.has(finding.id)
            const check = finding.checkId ? data.checksById.get(finding.checkId) : undefined
            const result = finding.checkId ? data.results.get(finding.checkId) : undefined
            return (
              <li
                key={finding.id}
                className="space-y-1.5 rounded-md border p-2"
                data-finding-id={finding.id}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {ownHunks.length > 0 && (
                    <Checkbox
                      aria-label={t("findings.select")}
                      checked={selected.has(finding.id)}
                      disabled={busy || kept}
                      onCheckedChange={() => setSelected((current) => toggle(current, finding.id))}
                    />
                  )}
                  <span className="text-xs font-medium">{t(`pattern.${finding.pattern}`)}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {t(`confidence.${finding.confidence}`)}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {t(`action.${finding.action}`)}
                  </Badge>
                  {ownHunks.some((hunk) => hunk.proposedOnly) && (
                    <Badge
                      variant="outline"
                      className="text-[10px]"
                      title={t("findings.proposedOnlyHint")}
                    >
                      {t("findings.proposedOnly")}
                    </Badge>
                  )}
                  {kept && <Badge className="text-[10px]">{t("findings.kept")}</Badge>}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {finding.id}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {names.get(finding.location.surfaceKey) ?? finding.location.surfaceKey}
                  {finding.location.startLine !== undefined
                    ? ` · ${t("findings.lines", { range: lineRange(finding.location.startLine, finding.location.endLine) })}`
                    : ""}
                </p>
                <blockquote className="border-l-2 pl-2 text-xs">{finding.evidence}</blockquote>
                <p className="text-xs">{finding.reason || t(`explain.${finding.pattern}`)}</p>
                {result && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("findings.adherenceLine", {
                      followed: result.followed,
                      opportunities: result.opportunities,
                    })}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {ownHunks.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded((current) => toggle(current, finding.id))}
                    >
                      {expanded.has(finding.id) ? t("findings.hideDiff") : t("findings.showDiff")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => act(runtime.setKept(workspaceId, finding.id, !kept), t)}
                  >
                    {kept ? t("findings.unkeep") : t("findings.keep")}
                  </Button>
                  {hasPromptCenterEntry(finding.location.surfaceKey) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        runtime.openInPromptCenter(finding.location.surfaceKey, workspaceId)
                      }
                    >
                      {t("common.openInPromptCenter")}
                    </Button>
                  )}
                  {finding.action === "enforce" && check && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setEnforcing(enforcing === finding.id ? null : finding.id)}
                    >
                      {t("findings.enforce")}
                    </Button>
                  )}
                </div>
                {enforcing === finding.id && check && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2 text-xs">
                    <span>{t("enforcement.adoptPrompt")}</span>
                    {(["remind", "block"] as const).map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        size="sm"
                        variant={mode === "block" ? "destructive" : "default"}
                        onClick={() => {
                          setEnforcing(null)
                          act(runtime.adopt(check, mode, workspaceId, finding.id), t)
                        }}
                      >
                        {t(`enforcement.mode.${mode}`)}
                      </Button>
                    ))}
                  </div>
                )}
                {expanded.has(finding.id) &&
                  ownHunks.map((hunk) => (
                    <div key={`${hunk.surfaceKey}:${hunk.startLine}`} className="space-y-1">
                      {hunk.surfaceKey !== finding.location.surfaceKey && (
                        <p className="text-[11px] text-muted-foreground">
                          {t("findings.moveTo", {
                            name: names.get(hunk.surfaceKey) ?? hunk.surfaceKey,
                          })}
                        </p>
                      )}
                      <DiffView lines={renderHunk(hunk)} label={t("findings.diffLabel")} />
                    </div>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
