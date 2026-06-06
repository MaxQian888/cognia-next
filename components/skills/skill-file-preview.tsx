"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, FileCodeIcon, FileTextIcon, ImageIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { SkillsShFileTreeNode } from "@/lib/skills/skillssh-install"
import type { FileTreeEntry } from "@/hooks/skills"

function iconFor(node: SkillsShFileTreeNode) {
  if (node.kind === "asset") return <ImageIcon className="size-3.5 shrink-0" />
  if (node.kind === "script") return <FileCodeIcon className="size-3.5 shrink-0" />
  return <FileTextIcon className="size-3.5 shrink-0" />
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

interface Props {
  files: FileTreeEntry | undefined
  className?: string
}

/**
 * Collapsible read-only file manifest for a skills.sh snapshot — what lands
 * as skill + resources when the item is installed. Icons follow the editor
 * file-tree conventions.
 */
export function SkillFilePreview({ files, className }: Props) {
  const t = useTranslations("skills.marketplace.files")
  const [open, setOpen] = useState(false)

  if (files === "loading" || files === undefined) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
        <Spinner className="size-3" />
        {t("loading")}
      </div>
    )
  }
  if (files.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{t("empty")}</p>
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger
        className="flex items-center gap-1 text-xs font-medium hover:underline"
        data-testid="skill-file-preview-trigger"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {t("title", { count: files.length })}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul
          className="mt-1.5 space-y-0.5 border-l pl-3"
          aria-label={t("ariaLabel")}
          data-testid="skill-file-preview-list"
        >
          {files.map((node) => (
            <li
              key={node.path}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            >
              {iconFor(node)}
              <span
                className={cn("truncate", node.kind === "skill" && "font-medium text-foreground")}
              >
                {node.path}
              </span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums">
                {formatSize(node.size)}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
