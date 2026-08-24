"use client"

/**
 * "You are looking at THIS directory" — the shared header element for every
 * panel that operates on a filesystem root.
 *
 * A panel that silently retargets is worse than one that needs an extra click:
 * the user types `rm -rf build` believing they know where they are, or edits a
 * worktree copy of a file for ten minutes before noticing. So the resolved root
 * is always on screen, and a managed worktree alias says so rather than looking
 * like an ordinary checkout.
 *
 * Pinning lives here too, and only for the panels that get it
 * (`PINNABLE_PANELS`): Source Control, the editor and search all answer
 * comparison questions — "what does this look like on main" — while a terminal
 * pinned away from the conversation is a loaded gun. Passing `onTogglePin` for
 * an execution panel is a programming error rather than a supported mode: the
 * resolver ignores such a pin, so the control would lie.
 */

import { useTranslations } from "next-intl"
import { FolderIcon, GitBranchIcon, PinIcon, PinOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  isPinnablePanel,
  type PanelRootTarget,
  type WorkspacePanel,
} from "@/lib/workspace/panel-follow"
import { cn } from "@/lib/utils"

export interface PanelRootChipProps {
  panel: WorkspacePanel
  target: PanelRootTarget
  /** Omitted for a panel that always follows; ignored for one that must. */
  onTogglePin?: () => void
  className?: string
}

/** Last path segment — the whole path is in the tooltip. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function PanelRootChip({ panel, target, onTogglePin, className }: PanelRootChipProps) {
  const t = useTranslations("workspace.panelRoot")
  const pinnable = isPinnablePanel(panel)
  const pinned = target.source === "pinned"

  if (!target.root) {
    return (
      <span
        className={cn("text-[11px] text-muted-foreground", className)}
        data-testid="panel-root-chip-empty"
      >
        {t("none")}
      </span>
    )
  }

  const stateLabel = pinned
    ? t("pinned")
    : target.managed
      ? t("worktree")
      : target.source === "execution"
        ? t("following")
        : t("workspace")

  return (
    <div
      className={cn("flex min-w-0 items-center gap-1", className)}
      data-testid="panel-root-chip"
      data-source={target.source}
      data-managed={target.managed ? "true" : "false"}
    >
      {/* A native title rather than the Radix tooltip: this chip is meant to
          drop into any panel header, and requiring a `TooltipProvider` above
          each of them would be a coupling the content (one path) never earns.
          The full path matters because a basename is exactly what makes two
          worktrees of the same repo indistinguishable. */}
      <span
        title={target.root}
        className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
      >
        {target.managed ? (
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <FolderIcon aria-hidden className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate font-mono" data-testid="panel-root-name">
          {basename(target.root)}
        </span>
        <span className="shrink-0 opacity-70">· {stateLabel}</span>
      </span>

      {pinnable && onTogglePin ? (
        <Button
          size="icon"
          variant="ghost"
          className="size-5 shrink-0"
          aria-label={pinned ? t("unpinLabel") : t("pinLabel")}
          title={pinned ? t("unpinLabel") : t("pinLabel")}
          data-testid="panel-root-pin"
          data-pinned={pinned ? "true" : "false"}
          onClick={onTogglePin}
        >
          {pinned ? (
            <PinOffIcon aria-hidden className="size-3" />
          ) : (
            <PinIcon aria-hidden className="size-3" />
          )}
        </Button>
      ) : null}
    </div>
  )
}
