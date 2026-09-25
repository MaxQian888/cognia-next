"use client"

/**
 * The left pane: commit box on top, then the Merge / Staged / Changes groups
 * with per-file and group-level actions.
 *
 * Rows enter and leave with a short height-and-fade, so staging a file reads
 * as the row moving from Changes to Staged rather than two lists redrawing.
 * Only below `ROW_MOTION_LIMIT` files and never under reduced motion: a
 * 2,000-file checkout after a branch switch must not animate 2,000 heights.
 */

import { Fragment, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react"
import { CheckIcon, MinusIcon, Trash2Icon } from "lucide-react"
import { MOBILE_EASE, MOBILE_DURATION } from "@/lib/ui/motion"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import type { GitStatus, GitStatusGroup } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useGitStore } from "@/stores/git/git-store"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { ChangeGroup } from "./change-group"
import { ChangeItem } from "./change-item"
import { CommitBox } from "./commit-box"
import { DiscardConfirmDialog } from "./discard-confirm-dialog"

/** Above this many changed files, rows render without enter/exit motion. */
export const ROW_MOTION_LIMIT = 150

/**
 * Height + fade. `overflow` is hidden only while the height moves and released
 * at rest, so a settled row's focus ring is never clipped.
 */
const ROW_VARIANTS: Variants = {
  hidden: {
    opacity: 0,
    height: 0,
    overflow: "hidden",
    transition: { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE },
  },
  shown: {
    opacity: 1,
    height: "auto",
    transition: { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE },
    transitionEnd: { overflow: "visible" },
  },
}

/** One group's rows, animated when `animate`, plain otherwise. */
function ChangeRows({
  animate,
  rows,
}: {
  animate: boolean
  rows: { key: string; node: ReactNode }[]
}) {
  if (!animate) {
    return (
      <>
        {rows.map((row) => (
          <Fragment key={row.key}>{row.node}</Fragment>
        ))}
      </>
    )
  }
  return (
    <AnimatePresence initial={false}>
      {rows.map((row) => (
        <motion.div
          key={row.key}
          variants={ROW_VARIANTS}
          initial="hidden"
          animate="shown"
          exit="hidden"
          data-testid="change-row-motion"
        >
          {row.node}
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

/** A discard the user requested that may be behind a confirmation. */
type PendingDiscard = { kind: "file"; path: string } | { kind: "all"; includeUntracked: boolean }

interface ChangesViewProps {
  variant?: "panel" | "review"
  density?: "compact" | "touch"
  rootDir: string
  status: GitStatus
  actions: UseGitActionsResult
  committing: boolean
  selectedPath: string | null
  onSelectFile: (path: string, staged: boolean) => void
  onViewHistory?: (path: string) => void
  onViewBlame?: (path: string) => void
  onRestore?: (path: string) => void
}

export function ChangesView({
  variant = "panel",
  density = "compact",
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
  const { prefs } = useSourceControlPrefs()
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null)
  const can = actions.can ?? (() => true)

  const runDiscard = (d: PendingDiscard) => {
    if (d.kind === "file") void actions.discard([d.path])
    else void actions.discardAll(d.includeUntracked)
  }

  // Confirm first when the pref is on; otherwise discard immediately.
  const requestDiscard = (d: PendingDiscard) => {
    if (prefs.confirmDiscard) setPendingDiscard(d)
    else runDiscard(d)
  }

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path)
  }

  const isExpanded = (g: GitStatusGroup) => expandedGroups[g]
  const total = status.merge.length + status.staged.length + status.changes.length
  const hasChanges = total > 0
  const reduceMotion = useReducedMotion()
  const animateRows = !reduceMotion && total <= ROW_MOTION_LIMIT

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-view">
      {variant === "panel" && (
        <CommitBox
          rootDir={rootDir}
          stagedCount={status.staged.length}
          committing={committing}
          actions={actions}
        />
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-1 pb-4">
          {status.merge.length > 0 && (
            <ChangeGroup
              group="merge"
              count={status.merge.length}
              expanded={isExpanded("merge")}
              onToggle={() => toggleGroup("merge")}
              density={density}
            >
              <ChangeRows
                animate={animateRows}
                rows={status.merge.map((c) => ({
                  key: `merge:${c.path}`,
                  node: (
                    <ChangeItem
                      change={c}
                      selected={selectedPath === c.path}
                      onSelect={() => onSelectFile(c.path, false)}
                      onCopyPath={() => copyPath(c.path)}
                      onViewHistory={onViewHistory ? () => onViewHistory(c.path) : undefined}
                      onViewBlame={onViewBlame ? () => onViewBlame(c.path) : undefined}
                      density={density}
                    />
                  ),
                }))}
              />
            </ChangeGroup>
          )}

          {status.staged.length > 0 && (
            <ChangeGroup
              group="staged"
              count={status.staged.length}
              expanded={isExpanded("staged")}
              onToggle={() => toggleGroup("staged")}
              density={density}
              actions={[
                {
                  key: "unstage-all",
                  label: t("actions.unstageAll"),
                  icon: <MinusIcon className="size-3" />,
                  onClick: () => void actions.unstage(status.staged.map((c) => c.path)),
                  disabled: !can("git_unstage"),
                },
              ]}
            >
              <ChangeRows
                animate={animateRows}
                rows={status.staged.map((c) => ({
                  key: `staged:${c.path}`,
                  node: (
                    <ChangeItem
                      change={c}
                      selected={selectedPath === c.path}
                      onSelect={() => onSelectFile(c.path, true)}
                      onUnstage={
                        can("git_unstage") ? () => void actions.unstage([c.path]) : undefined
                      }
                      onCopyPath={() => copyPath(c.path)}
                      onViewHistory={onViewHistory ? () => onViewHistory(c.path) : undefined}
                      onViewBlame={onViewBlame ? () => onViewBlame(c.path) : undefined}
                      onRestore={onRestore ? () => onRestore(c.path) : undefined}
                      density={density}
                    />
                  ),
                }))}
              />
            </ChangeGroup>
          )}

          {status.changes.length > 0 && (
            <ChangeGroup
              group="changes"
              count={status.changes.length}
              expanded={isExpanded("changes")}
              onToggle={() => toggleGroup("changes")}
              density={density}
              actions={[
                {
                  key: "stage-all",
                  label: t("actions.stageAll"),
                  icon: <CheckIcon className="size-3" />,
                  onClick: () => void actions.stage(status.changes.map((c) => c.path)),
                  disabled: !can("git_stage"),
                },
                {
                  key: "discard-all",
                  label: t("actions.discardAll"),
                  icon: <Trash2Icon className="size-3" />,
                  destructive: true,
                  onClick: () => requestDiscard({ kind: "all", includeUntracked: true }),
                  disabled: !can("git_discard_all"),
                },
              ]}
            >
              <ChangeRows
                animate={animateRows}
                rows={status.changes.map((c) => ({
                  key: `changes:${c.path}`,
                  node: (
                    <ChangeItem
                      change={c}
                      selected={selectedPath === c.path}
                      onSelect={() => onSelectFile(c.path, false)}
                      onStage={can("git_stage") ? () => void actions.stage([c.path]) : undefined}
                      onDiscard={
                        can("git_discard")
                          ? () => requestDiscard({ kind: "file", path: c.path })
                          : undefined
                      }
                      onCopyPath={() => copyPath(c.path)}
                      onViewHistory={onViewHistory ? () => onViewHistory(c.path) : undefined}
                      onViewBlame={onViewBlame ? () => onViewBlame(c.path) : undefined}
                      onRestore={onRestore ? () => onRestore(c.path) : undefined}
                      onAddToGitignore={
                        can("git_ignore_add") ? () => void actions.ignoreAdd(c.path) : undefined
                      }
                      density={density}
                    />
                  ),
                }))}
              />
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

      <DiscardConfirmDialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null)
        }}
        fileName={pendingDiscard?.kind === "file" ? pendingDiscard.path : null}
        onConfirm={() => {
          if (pendingDiscard) runDiscard(pendingDiscard)
          setPendingDiscard(null)
        }}
      />
    </div>
  )
}
