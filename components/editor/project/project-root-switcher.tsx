"use client"

// Root selector for the project editor: the main repo plus any git worktrees.
// Switching rebuilds the file tree and re-roots the LSP workspaceFolder.
//
// The selection IS the pin (ADR-0144): the entry matching `followedRoot` is
// where the bound conversation runs, and picking any other entry deliberately
// holds the editor away from it. Marking that entry is what keeps the switcher
// from being a second, silent way to answer "which directory" — the user can
// see which choice means "follow" and get back to it in one click.

import { useTranslations } from "next-intl"
import { GitBranchIcon } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ProjectRoot } from "./use-project-editor"

interface Props {
  roots: ProjectRoot[]
  rootKey: string
  onSelect: (key: string) => void
  /** The bound conversation's execution root, when there is one. */
  followedRoot?: string | null
  density?: "compact" | "touch"
}

export function ProjectRootSwitcher({
  roots,
  rootKey,
  onSelect,
  followedRoot,
  density = "compact",
}: Props) {
  const t = useTranslations("projectEditor")
  const followed = followedRoot?.trim() || null
  if (roots.length <= 1) return null
  return (
    <Select value={rootKey} onValueChange={onSelect}>
      <SelectTrigger
        className={
          density === "touch" ? "h-10 w-full gap-2 text-sm" : "h-7 w-[12rem] gap-1 text-xs"
        }
        aria-label={t("rootLabel")}
        data-testid="project-root-switcher"
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roots.map((r) => (
          <SelectItem key={r.key} value={r.key} className="text-xs">
            {r.key === followed
              ? t("rootFollowing", { name: r.isMain ? t("rootMain") : r.label })
              : r.isMain
                ? t("rootMain")
                : r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
