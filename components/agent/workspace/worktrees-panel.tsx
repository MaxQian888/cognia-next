"use client"

/**
 * Workspace → Worktrees tab. Lists the per-dispatch agent branches produced by
 * workspace-isolated runs (`agent/<runId>/<teammate>/<taskId>`) — the durable
 * artifact once the run reclaims its worktree directories. Each branch can be
 * checked out, compared against another ref, or deleted. Desktop + git only;
 * renders a placeholder on web (git ops run in Rust/Tauri).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { CompareRefsSheet } from "@/components/source-control/compare-refs-sheet"
import { isTauri } from "@/lib/tauri"
import { gitBranches, gitCheckoutBranch, gitDeleteBranch } from "@/lib/git/commands"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { GitBranch } from "@/types/git"
import { createLogger } from "@/lib/logging"

const log = createLogger("agentTeams.worktrees")

export interface WorktreesPanelProps {
  team: AgentTeam
}

export function WorktreesPanel({ team }: WorktreesPanelProps) {
  const t = useTranslations("agentTeamsWorkspace.worktrees")
  const repo = team.config?.workingDir
  const desktop = isTauri()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!desktop || !repo) return
    setLoading(true)
    try {
      const all = await gitBranches(repo)
      setBranches(all.filter((b) => b.name.startsWith("agent/")))
    } catch (err) {
      log.warn("branches_load_failed", { err: String(err) })
    } finally {
      setLoading(false)
    }
  }, [desktop, repo])

  const doCheckout = useCallback(
    async (name: string) => {
      if (!repo) return
      try {
        await gitCheckoutBranch(repo, name)
      } catch (err) {
        log.warn("checkout_failed", { name, err: String(err) })
      }
    },
    [repo]
  )

  const doDelete = useCallback(
    async (name: string) => {
      if (!repo) return
      try {
        await gitDeleteBranch(repo, name, true)
        await refresh()
      } catch (err) {
        log.warn("delete_failed", { name, err: String(err) })
      }
    },
    [repo, refresh]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load branches on mount
    void refresh()
  }, [refresh])

  if (!desktop || !repo) {
    return (
      <Empty data-testid="worktrees-desktop-only">
        <EmptyHeader>
          <EmptyTitle>{t("desktopOnly.title")}</EmptyTitle>
          <EmptyDescription>{t("desktopOnly.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="space-y-3" data-testid="worktrees-panel">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("title")}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      {branches.length === 0 ? (
        <Empty data-testid="worktrees-empty">
          <EmptyHeader>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-2" data-testid="worktrees-list">
          {branches.map((b) => (
            <li key={b.name}>
              <Card className="flex items-center justify-between gap-2 p-3">
                <span className="flex min-w-0 items-center gap-2">
                  <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">{b.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => void doCheckout(b.name)}>
                    {t("actions.checkout")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void doDelete(b.name)}>
                    {t("actions.delete")}
                  </Button>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
        {t("actions.compare")}
      </Button>
      <CompareRefsSheet open={compareOpen} onOpenChange={setCompareOpen} rootDir={repo} />
    </div>
  )
}
