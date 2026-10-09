"use client"

/**
 * The left pane: commit box on top, then the Merge / Staged / Changes groups
 * with per-file and group-level actions.
 *
 * Rows enter and leave with a short height-and-fade, so staging a file reads
 * as the row moving from Changes to Staged rather than two lists redrawing.
 * Only below `ROW_MOTION_LIMIT` files and never under reduced motion: a
 * 2,000-file checkout after a branch switch must not animate 2,000 heights.
 *
 * Above that limit the list is also virtualized: group headers and rows are
 * flattened into one windowed list, so a status refresh — which lands on every
 * agent write — renders the rows on screen, not two thousand context-menu
 * roots.
 */

import { Fragment, useMemo, useRef, useState, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react"
import { CheckIcon, CircleCheckIcon, HistoryIcon, MinusIcon, Trash2Icon } from "lucide-react"
import { MOBILE_EASE, MOBILE_DURATION } from "@/lib/ui/motion"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { GitFileChange, GitStatus, GitStatusGroup } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useGitStore } from "@/stores/git/git-store"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { ChangeGroup, type GroupAction } from "./change-group"
import { ChangeItem } from "./change-item"
import { CommitBox } from "./commit-box"
import { DiscardConfirmDialog } from "./discard-confirm-dialog"

/** Above this many changed files, rows render without enter/exit motion, windowed. */
export const ROW_MOTION_LIMIT = 150

/** Row height estimates for the windowed list; real heights are measured. */
const ESTIMATED_ROW_HEIGHT = { compact: 24, touch: 44 } as const

type FlatEntry =
  | { kind: "group"; group: GitStatusGroup; count: number }
  | { kind: "row"; group: GitStatusGroup; change: GitFileChange }

const GROUP_ORDER: readonly GitStatusGroup[] = ["merge", "staged", "changes"]

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
  /** Opens the repository's history; offered from the clean-tree state. */
  onOpenHistory?: () => void
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
  onOpenHistory,
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

  const groupActions = (group: GitStatusGroup): GroupAction[] => {
    if (group === "staged") {
      return [
        {
          key: "unstage-all",
          label: t("actions.unstageAll"),
          icon: <MinusIcon className="size-3" />,
          onClick: () => void actions.unstage(status.staged.map((c) => c.path)),
          disabled: !can("git_unstage"),
        },
      ]
    }
    if (group === "changes") {
      return [
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
      ]
    }
    return []
  }

  const renderItem = (group: GitStatusGroup, c: GitFileChange) => {
    const shared = {
      change: c,
      selected: selectedPath === c.path,
      onSelect: () => onSelectFile(c.path, group === "staged"),
      onCopyPath: () => copyPath(c.path),
      onViewHistory: onViewHistory ? () => onViewHistory(c.path) : undefined,
      onViewBlame: onViewBlame ? () => onViewBlame(c.path) : undefined,
      density,
    }
    if (group === "merge") return <ChangeItem {...shared} />
    if (group === "staged") {
      return (
        <ChangeItem
          {...shared}
          onUnstage={can("git_unstage") ? () => void actions.unstage([c.path]) : undefined}
          onRestore={onRestore ? () => onRestore(c.path) : undefined}
        />
      )
    }
    return (
      <ChangeItem
        {...shared}
        onStage={can("git_stage") ? () => void actions.stage([c.path]) : undefined}
        onDiscard={
          can("git_discard") ? () => requestDiscard({ kind: "file", path: c.path }) : undefined
        }
        onRestore={onRestore ? () => onRestore(c.path) : undefined}
        onAddToGitignore={can("git_ignore_add") ? () => void actions.ignoreAdd(c.path) : undefined}
      />
    )
  }

  const groupHeader = (group: GitStatusGroup, children: ReactNode) => (
    <ChangeGroup
      group={group}
      count={status[group].length}
      expanded={isExpanded(group)}
      onToggle={() => toggleGroup(group)}
      density={density}
      actions={groupActions(group)}
    >
      {children}
    </ChangeGroup>
  )

  const windowed = total > ROW_MOTION_LIMIT

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
      {windowed ? (
        <WindowedChanges
          status={status}
          expandedGroups={expandedGroups}
          density={density}
          renderHeader={(group) => groupHeader(group, null)}
          renderItem={renderItem}
        />
      ) : (
        // `!block`: Radix wraps the viewport's children in a `display:table`
        // div that grows to the longest path, so on a phone (and a 480px dock)
        // rows ran off the right edge with their Stage / Discard buttons.
        <ScrollArea
          className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block"
          data-testid="changes-scroll"
        >
          <div className="flex flex-col gap-1 px-1 pb-4">
            {GROUP_ORDER.map((group) =>
              status[group].length > 0 ? (
                <Fragment key={group}>
                  {groupHeader(
                    group,
                    <ChangeRows
                      animate={animateRows}
                      rows={status[group].map((c) => ({
                        key: `${group}:${c.path}`,
                        node: renderItem(group, c),
                      }))}
                    />
                  )}
                </Fragment>
              ) : null
            )}

            {/* A clean tree is a result, not an absence: say so, say what
                will appear here, and offer the one useful next step. */}
            {!hasChanges && (
              <Empty className="mt-6 gap-4 border-0 p-4" data-testid="no-changes">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CircleCheckIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm">{t("emptyState.noChanges")}</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    {t("emptyState.noChangesDescription")}
                  </EmptyDescription>
                </EmptyHeader>
                {onOpenHistory && (
                  <EmptyContent>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={onOpenHistory}
                      data-testid="no-changes-history"
                    >
                      <HistoryIcon className="size-3.5" />
                      {t("emptyState.viewHistory")}
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            )}
          </div>
        </ScrollArea>
      )}

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

/**
 * The windowed list: Merge / Staged / Changes headers and their rows (rows of
 * a collapsed group left out) flattened into one virtualizer. Rows are
 * measured, so a wrapped path or a touch-height row never overlaps its
 * neighbour.
 */
function WindowedChanges({
  status,
  expandedGroups,
  density,
  renderHeader,
  renderItem,
}: {
  status: GitStatus
  expandedGroups: Record<GitStatusGroup, boolean>
  density: "compact" | "touch"
  renderHeader: (group: GitStatusGroup) => ReactNode
  renderItem: (group: GitStatusGroup, change: GitFileChange) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const entries = useMemo<FlatEntry[]>(() => {
    const out: FlatEntry[] = []
    for (const group of GROUP_ORDER) {
      const changes = status[group]
      if (changes.length === 0) continue
      out.push({ kind: "group", group, count: changes.length })
      if (!expandedGroups[group]) continue
      for (const change of changes) out.push({ kind: "row", group, change })
    }
    return out
  }, [status, expandedGroups])

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      entries[index]?.kind === "group"
        ? density === "touch"
          ? 44
          : 28
        : ESTIMATED_ROW_HEIGHT[density],
    overscan: 12,
    getItemKey: (index) => {
      const entry = entries[index]
      if (!entry) return index
      return entry.kind === "group" ? `group:${entry.group}` : `${entry.group}:${entry.change.path}`
    },
  })

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-1 pb-4"
      data-testid="changes-windowed"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = entries[item.index]
          if (!entry) return null
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {entry.kind === "group"
                ? renderHeader(entry.group)
                : renderItem(entry.group, entry.change)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
