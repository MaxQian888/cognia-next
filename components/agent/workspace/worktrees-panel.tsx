"use client"

/**
 * Workspace → Worktrees tab.
 *
 * Two different things live under that word and the tab used to show only the
 * second one, which is why it could be open on a machine with live worktrees
 * and appear empty:
 *
 *  1. **Live environments.** The worktree directories that exist right now.
 *     `WorkspaceEnvironmentList` is the canonical inventory for these, shared
 *     with `/workspace` and the Source Control sheet, and it is the only place
 *     they can be pinned, adopted, archived or removed.
 *  2. **Reclaimed agent branches.** `agent/<runId>/<teammate>/<taskId>`, the
 *     durable artifact left behind once a run reclaims its directory. These
 *     are branches, not worktrees, and listing them is deliberate: after a run
 *     settles they are the only trace of what it did.
 *
 * Both sections are host-neutral. The git reads and writes here go through
 * `runGitUserAction`, so they work against a paired host from web and mobile
 * rather than rendering a desktop-only placeholder.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { CompareRefsSheet } from "@/components/source-control/compare-refs-sheet"
import { WorkspaceEnvironmentList } from "@/components/workspace/workspace-environment-list"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import {
  gitBranches,
  gitCheckoutBranch,
  gitDeleteBranch,
  runGitUserAction,
} from "@/lib/git/commands"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { GitBranch } from "@/types/git"
import { createLogger } from "@cognia/logging"

const log = createLogger("agentTeams.worktrees")

export interface WorktreesPanelProps {
  team: AgentTeam
}

export function WorktreesPanel({ team }: WorktreesPanelProps) {
  const t = useTranslations("agentTeamsWorkspace.worktrees")
  const repo = team.config?.workingDir
  const gate = useWorkspaceCommandGate()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!repo) return
    setLoading(true)
    try {
      const all = await gitBranches(repo)
      setBranches(all.filter((b) => b.name.startsWith("agent/")))
    } catch (err) {
      log.warn("branches_load_failed", { err: String(err) })
    } finally {
      setLoading(false)
    }
  }, [repo])

  const doCheckout = useCallback(
    async (name: string) => {
      if (!repo) return
      try {
        // Checkout is `approval: "interactive"`, so from a paired client it
        // needs a lease. Bare, it answered `interactive_approval_required`.
        await runGitUserAction("git_checkout_branch", () => gitCheckoutBranch(repo, name))
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
        await runGitUserAction("git_delete_branch", () => gitDeleteBranch(repo, name, true))
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

  // Only a team with no working directory has nothing to show. That is a
  // configuration gap, not a host one, so it no longer reads "desktop only".
  if (!repo) {
    return (
      <Empty data-testid="worktrees-desktop-only">
        <EmptyHeader>
          <EmptyTitle>{t("desktopOnly.title")}</EmptyTitle>
          <EmptyDescription>{t("desktopOnly.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const checkoutGate = gate("git_checkout_branch")
  const deleteGate = gate("git_delete_branch")

  return (
    <div className="space-y-6" data-testid="worktrees-panel">
      {/* The live directories, through the one inventory that owns them. */}
      <WorkspaceEnvironmentList rootDir={repo} showCreate />

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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!checkoutGate.available}
                    title={checkoutGate.reason ?? undefined}
                    onClick={() => void doCheckout(b.name)}
                  >
                    {t("actions.checkout")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!deleteGate.available}
                    title={deleteGate.reason ?? undefined}
                    onClick={() => void doDelete(b.name)}
                  >
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
