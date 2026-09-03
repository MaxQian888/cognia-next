"use client"

/**
 * Branches left behind by isolated runs, and the way to reclaim them.
 *
 * A run with worktree isolation cuts `agent/<run>/<teammate>/<task>`, works in
 * it, and gives the directory back when it settles. The branch outlives the
 * directory, and after a run has settled it is the only trace of what the run
 * did, so the list is deliberately of branches rather than worktrees. The live
 * directories are `WorkspaceEnvironmentList`, one section above this one.
 *
 * # Why it lives here
 *
 * It used to be the second half of `components/agent/workspace/worktrees-panel`,
 * a tab of `/agent-teams/workspace`, which ADR-0140 retired and took out of
 * navigation. The branches pile up in the REPOSITORY, not in a squad, so the
 * reclaim view belongs to the workspace that owns the checkout. That is also
 * the scope change: this reads the workspace's primary root, where the old
 * panel read one squad's configured working directory. A squad working outside
 * the workspace's roots is answered from its own detail surface, not by
 * widening this one until it means nothing.
 *
 * # Host-neutral
 *
 * Every read and write goes through `runGitUserAction`, so it works against a
 * paired host from web and mobile. Checkout and delete are
 * `approval: "interactive"`, and bare `transport.call` answers
 * `interactive_approval_required` from a paired client.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, RefreshCwIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Button } from "@/components/ui/button"
import { CompareRefsSheet } from "@/components/source-control/compare-refs-sheet"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import { AGENT_BRANCH_PREFIX as AGENT_PREFIX } from "@/lib/git/branch-placement"
import {
  gitBranches,
  gitCheckoutBranch,
  gitDeleteBranch,
  runGitUserAction,
} from "@/lib/git/commands"
import type { GitBranch } from "@/types/git"
import { createLogger } from "@cognia/logging"

const log = createLogger("workspace.agentBranches")

/**
 * The prefix every isolated run's branch carries.
 *
 * Re-exported rather than declared: `lib/git/branch-placement` owns it now, so
 * the branch picker's agent badge and this reclaim list cannot drift apart on
 * what counts as an agent branch.
 */
export { AGENT_BRANCH_PREFIX } from "@/lib/git/branch-placement"

export interface AgentBranchesSectionProps {
  /** The repository to read. Absent while the workspace has no root yet. */
  rootDir?: string
}

export function AgentBranchesSection({ rootDir }: AgentBranchesSectionProps) {
  const t = useTranslations("workspace.agentBranches")
  const gate = useWorkspaceCommandGate()
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [loading, setLoading] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!rootDir) return
    setLoading(true)
    try {
      const all = await gitBranches(rootDir)
      setBranches(all.filter((branch) => branch.name.startsWith(AGENT_PREFIX)))
    } catch (err) {
      // A directory that is not a git repository is the ordinary case for a
      // workspace root, not a failure worth an alert.
      log.warn("branches_load_failed", { err: String(err) })
      setBranches([])
    } finally {
      setLoading(false)
    }
  }, [rootDir])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load branches on mount
    void refresh()
  }, [refresh])

  const doCheckout = useCallback(
    async (name: string) => {
      if (!rootDir) return
      try {
        await runGitUserAction("git_checkout_branch", () => gitCheckoutBranch(rootDir, name))
      } catch (err) {
        log.warn("checkout_failed", { name, err: String(err) })
      }
    },
    [rootDir]
  )

  const doDelete = useCallback(
    async (name: string) => {
      if (!rootDir) return
      try {
        await runGitUserAction("git_delete_branch", () => gitDeleteBranch(rootDir, name, true))
        await refresh()
      } catch (err) {
        log.warn("delete_failed", { name, err: String(err) })
      }
    },
    [rootDir, refresh]
  )

  // Nothing to read and nothing to say. The section is about a repository, and
  // a workspace with no root has none.
  if (!rootDir) return null

  const checkoutGate = gate("git_checkout_branch")
  const deleteGate = gate("git_delete_branch")

  return (
    <ConsoleSection
      id="agent-branches"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={GitBranchIcon}
      title={t("title")}
      description={t("description")}
      meta={
        <span className="flex items-center gap-1">
          <span className="tabular-nums">{branches.length}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-my-1 size-6"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t("refresh")}
          >
            <RefreshCwIcon aria-hidden className="size-3.5" />
          </Button>
        </span>
      }
    >
      {branches.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="workspace-agent-branches-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="workspace-agent-branches">
          {branches.map((branch) => (
            <li
              key={branch.name}
              className="flex items-center gap-2 rounded-control border px-3 py-2"
              data-testid={`workspace-agent-branch-${branch.name}`}
            >
              <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={branch.name}>
                {branch.name}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={!checkoutGate.available}
                title={checkoutGate.reason ?? undefined}
                data-unavailable={checkoutGate.available ? undefined : "true"}
                onClick={() => void doCheckout(branch.name)}
              >
                {t("actions.checkout")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={!deleteGate.available}
                title={deleteGate.reason ?? undefined}
                data-unavailable={deleteGate.available ? undefined : "true"}
                onClick={() => void doDelete(branch.name)}
              >
                {t("actions.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="-ml-2 mt-2 h-7 text-xs"
        onClick={() => setCompareOpen(true)}
        data-testid="workspace-agent-branches-compare"
      >
        {t("actions.compare")}
      </Button>
      <CompareRefsSheet open={compareOpen} onOpenChange={setCompareOpen} rootDir={rootDir} />
    </ConsoleSection>
  )
}
