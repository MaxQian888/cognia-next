"use client"

/**
 * Workspace -> Worktrees tab (retired route).
 *
 * Both halves of this panel have moved, so it is now a pointer rather than a
 * surface:
 *
 *  1. **Live environments** were `WorkspaceEnvironmentList`, the canonical
 *     inventory shared with `/workspace` and the Source Control sheet. Mounting
 *     it here was a third copy of the same list scoped to a squad's working
 *     directory instead of to a workspace.
 *  2. **Reclaimed agent branches** are `components/workspace/agent-branches-section`,
 *     in `/workspace` -> Environments. They pile up in the REPOSITORY, not in a
 *     squad, so the reclaim view belongs to the workspace that owns the
 *     checkout.
 *
 * `/agent-teams` is out of navigation (ADR-0140) and this file goes with the
 * route. It is left as a link rather than deleted in the same commit so the tab
 * is never a blank panel for anyone still holding the URL.
 */

import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"

export interface WorktreesPanelProps {
  /** Kept so the caller's prop shape does not change while the route is retired. */
  team?: unknown
}

export function WorktreesPanel(_props: WorktreesPanelProps) {
  const t = useTranslations("agentTeamsWorkspace.worktrees")

  return (
    <Empty data-testid="worktrees-panel">
      <EmptyHeader>
        <EmptyTitle>{t("moved.title")}</EmptyTitle>
        <EmptyDescription>{t("moved.description")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild size="sm">
          <Link href="/workspace" data-testid="worktrees-panel-moved-link">
            {t("moved.action")}
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}
