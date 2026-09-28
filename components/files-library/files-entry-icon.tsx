"use client"

/**
 * The glyph that stands for a Files entry when it has no image: the file-type
 * icon for uploads (by filename), a per-type glyph for artifacts, a pen for
 * canvas documents.
 */

import {
  BarChart3Icon,
  CodeIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  NetworkIcon,
  NotebookIcon,
  PenLineIcon,
  SigmaIcon,
  type LucideIcon,
} from "lucide-react"

import { FileTypeIcon } from "@/components/shared/file-type-icon"
import type { FilesEntry } from "@/lib/files-library/types"
import { cn } from "@/lib/utils"

const ARTIFACT_ICONS: Record<string, LucideIcon> = {
  code: CodeIcon,
  react: CodeIcon,
  document: FileTextIcon,
  html: GlobeIcon,
  svg: ImageIcon,
  mermaid: NetworkIcon,
  chart: BarChart3Icon,
  math: SigmaIcon,
  jupyter: NotebookIcon,
}

export function FilesEntryIcon({
  entry,
  className,
}: {
  entry: Pick<FilesEntry, "kind" | "subtype" | "title">
  className?: string
}) {
  if (entry.kind === "session-upload" || entry.kind === "upload") {
    return <FileTypeIcon path={entry.title || "file"} className={cn("size-8", className)} />
  }
  const Icon =
    entry.kind === "canvas"
      ? PenLineIcon
      : entry.kind === "image"
        ? ImageIcon
        : (ARTIFACT_ICONS[entry.subtype ?? ""] ?? FileTextIcon)
  return (
    <Icon
      className={cn("size-8 text-primary", className)}
      aria-hidden
      data-testid={`files-entry-icon-${entry.kind}`}
    />
  )
}
