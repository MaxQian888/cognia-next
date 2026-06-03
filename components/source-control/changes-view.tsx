"use client"

/**
 * The left pane: commit box on top, then the Merge / Staged / Changes groups
 * with per-file and group-level actions.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, MinusIcon, Trash2Icon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import type { GitStatus, GitStatusGroup } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useGitStore } from "@/stores/git/git-store"
import { ChangeGroup } from "./change-group"
import { ChangeItem } from "./change-item"
import { CommitBox } from "./commit-box"

interface ChangesViewProps {
  rootDir: string
  status: GitStatus
  actions: UseGitActionsResult
  committing: boolean
  selectedPath: string | null
  onSelectFile: (path: string, staged: boolean) => void
  onViewHistory: (path: string) => void
  onViewBlame: (path: string) => void
  onRestore: (path: string) => void
}

export function ChangesView({
  rootDir,
  status,
  actions,
  committing,
  selectedPath,
  onSelectFile,
  onViewHistory,
  onViewBlame,
  onRestore,
}: ChangesViewProps) {
  const t = useTranslations("sourceControl")
  const expandedGroups = useGitStore((s) => s.expandedGroups)
  const toggleGroup = useGitStore((s) => s.toggleGroup)

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path)
  }

  const isExpanded = (g: GitStatusGroup) => expandedGroups[g]
  const hasChanges = status.merge.length + status.staged.length + status.changes.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-view">
      <CommitBox
        rootDir={rootDir}
        stagedCount={status.staged.length}
        committing={committing}
        actions={actions}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-1 pb-4">
          {status.merge.length > 0 && (
            <ChangeGroup
              group="merge"
              count={status.merge.length}
              expanded={isExpanded("merge")}
              onToggle={() => toggleGroup("merge")}
            >
              {status.merge.map((c) => (
                <ChangeItem
                  key={`merge:${c.path}`}
                  change={c}
                  selected={selectedPath === c.path}
                  onSelect={() => onSelectFile(c.path, false)}
                  onCopyPath={() => copyPath(c.path)}
                  onViewHistory={() => onViewHistory(c.path)}
                  onViewBlame={() => onViewBlame(c.path)}
                />
              ))}
            </ChangeGroup>
          )}

          {status.staged.length > 0 && (
            <ChangeGroup
              group="staged"
              count={status.staged.length}
              expanded={isExpanded("staged")}
              onToggle={() => toggleGroup("staged")}
              actions={[
                {
                  key: "unstage-all",
                  label: t("actions.unstageAll"),
                  icon: <MinusIcon className="size-3" />,
                  onClick: () => void actions.unstage(status.staged.map((c) => c.path)),
                },
              ]}
            >
              {status.staged.map((c) => (
                <ChangeItem
                  key={`staged:${c.path}`}
                  change={c}
                  selected={selectedPath === c.path}
                  onSelect={() => onSelectFile(c.path, true)}
                  onUnstage={() => void actions.unstage([c.path])}
                  onCopyPath={() => copyPath(c.path)}
                  onViewHistory={() => onViewHistory(c.path)}
                  onViewBlame={() => onViewBlame(c.path)}
                  onRestore={() => onRestore(c.path)}
                />
              ))}
            </ChangeGroup>
          )}

          {status.changes.length > 0 && (
            <ChangeGroup
              group="changes"
              count={status.changes.length}
              expanded={isExpanded("changes")}
              onToggle={() => toggleGroup("changes")}
              actions={[
                {
                  key: "stage-all",
                  label: t("actions.stageAll"),
                  icon: <CheckIcon className="size-3" />,
                  onClick: () => void actions.stage(status.changes.map((c) => c.path)),
                },
                {
                  key: "discard-all",
                  label: t("actions.discardAll"),
                  icon: <Trash2Icon className="size-3" />,
                  destructive: true,
                  onClick: () => void actions.discardAll(true),
                },
              ]}
            >
              {status.changes.map((c) => (
                <ChangeItem
                  key={`changes:${c.path}`}
                  change={c}
                  selected={selectedPath === c.path}
                  onSelect={() => onSelectFile(c.path, false)}
                  onStage={() => void actions.stage([c.path])}
                  onDiscard={() => void actions.discard([c.path])}
                  onCopyPath={() => copyPath(c.path)}
                  onViewHistory={() => onViewHistory(c.path)}
                  onViewBlame={() => onViewBlame(c.path)}
                  onRestore={() => onRestore(c.path)}
                />
              ))}
            </ChangeGroup>
          )}

          {!hasChanges && (
            <Empty className="mt-8 border-0" data-testid="no-changes">
              <EmptyHeader>
                <EmptyDescription>{t("emptyState.noChanges")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
