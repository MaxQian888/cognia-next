"use client"

// Root selector for the project editor: the main repo plus any git worktrees.
// Switching rebuilds the file tree and re-roots the LSP workspaceFolder.

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
}

export function ProjectRootSwitcher({ roots, rootKey, onSelect }: Props) {
  const t = useTranslations("agentTeamsWorkspace.editor")
  if (roots.length <= 1) return null
  return (
    <Select value={rootKey} onValueChange={onSelect}>
      <SelectTrigger
        className="h-7 w-[12rem] gap-1 text-xs"
        aria-label={t("rootLabel")}
        data-testid="project-root-switcher"
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roots.map((r) => (
          <SelectItem key={r.key} value={r.key} className="text-xs">
            {r.isMain ? t("rootMain") : r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
