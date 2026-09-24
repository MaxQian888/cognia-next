"use client"

/**
 * The list behind `/workspace`'s "Agents working" tile.
 *
 * The tile was a bare count: the audit saw "Agents working 2" with no way to
 * learn which two. It now toggles this section, and both render the SAME
 * array from `listActiveAgentRuns`, so the number and the rows cannot
 * disagree. Each row names the issue the agent is working on and links to
 * where the run can be watched (its chat session, its Squad, the Character
 * task board before a session exists, or the issue for a GitHub loop).
 */

import Link from "next/link"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ArrowUpRightIcon, BotIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import type { ActiveAgentRun, ActiveAgentRunLinkKind } from "@/lib/workspace/active-agent-runs"

export const AGENTS_WORKING_SECTION_ID = "agents-working"
/** The DOM id `ConsoleSection` gives this section (`${idPrefix}-${id}`). */
export const AGENTS_WORKING_REGION_ID = `workspace-section-${AGENTS_WORKING_SECTION_ID}`

const OPEN_LABEL_KEY: Record<ActiveAgentRunLinkKind, string> = {
  session: "workspace.agentsWorkingOpen.session",
  squad: "workspace.agentsWorkingOpen.squad",
  "agent-board": "workspace.agentsWorkingOpen.agentBoard",
  issue: "workspace.agentsWorkingOpen.issue",
}

export interface WorkspaceAgentsWorkingProps {
  runs: readonly ActiveAgentRun[]
}

export function WorkspaceAgentsWorking({ runs }: WorkspaceAgentsWorkingProps) {
  const t = useTranslations("issues")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })

  return (
    <ConsoleSection
      id={AGENTS_WORKING_SECTION_ID}
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={BotIcon}
      title={t("workspace.agentsWorking")}
      meta={runs.length}
      wide
    >
      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="workspace-agents-working-empty">
          {t("workspace.agentsWorkingEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y" data-testid="workspace-agents-working-list">
          {runs.map((run) => {
            const engineKey = `run.adapter.${run.adapterId}.name`
            return (
              <li
                key={run.runId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2 text-xs first:pt-0 last:pb-0"
                data-testid={`workspace-agent-run-${run.runId}`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link
                    href={run.issueHref}
                    className="min-w-0 truncate font-medium hover:underline"
                    data-testid={`workspace-agent-run-issue-${run.runId}`}
                  >
                    {run.issueIdentifier ? (
                      <span className="mr-1.5 tabular-nums text-muted-foreground">
                        {run.issueIdentifier}
                      </span>
                    ) : null}
                    {run.issueTitle ?? t("workspace.agentsWorkingMissingIssue")}
                  </Link>
                  <span className="truncate text-muted-foreground">
                    {t("workspace.agentsWorkingMeta", {
                      engine: t.has(engineKey) ? t(engineKey) : run.adapterId,
                      time: format.relativeTime(run.startedAt, now),
                    })}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={run.status === "running" ? "default" : "secondary"}>
                    {t(`run.status.${run.status}`)}
                  </Badge>
                  <Link
                    href={run.href}
                    className="inline-flex items-center gap-1 rounded-control border px-2 py-1 font-medium hover:bg-muted"
                    data-testid={`workspace-agent-run-open-${run.runId}`}
                  >
                    {t(OPEN_LABEL_KEY[run.linkKind])}
                    <ArrowUpRightIcon aria-hidden className="size-3" />
                  </Link>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </ConsoleSection>
  )
}
