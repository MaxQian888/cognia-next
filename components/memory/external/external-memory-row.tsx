"use client"

import { useFormatter, useTranslations } from "next-intl"
import { FileTextIcon, LockIcon } from "lucide-react"
import type { ExternalMemoryFile } from "@/lib/memory/external/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

export interface ExternalMemoryRowProps {
  file: ExternalMemoryFile
  onOpen: (file: ExternalMemoryFile) => void
}

/**
 * One external agent-memory file in the `/memory` → external tab. Mirrors
 * `memory-row.tsx`: translucent theme-aware surface, agent + scope badges, muted
 * path, size, and a lock cue for read-only (managed / Codex-owned) files. The
 * whole row is a button that opens the viewer/editor dialog.
 */
export function ExternalMemoryRow({ file, onOpen }: ExternalMemoryRowProps) {
  const t = useTranslations("memory.external")
  const format = useFormatter()

  return (
    <button
      type="button"
      data-testid="external-memory-row"
      data-agent={file.agent}
      data-scope={file.scope}
      onClick={() => onOpen(file)}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-border/50 bg-card/80 p-3 text-left backdrop-blur-sm",
        "transition-colors hover:bg-accent/50",
        !file.exists && "opacity-60"
      )}
    >
      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{file.label}</span>
          <Badge variant="secondary" className="text-[10px]">
            {t(`scopes.${file.scope}`)}
          </Badge>
          {!file.editable && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <LockIcon className="size-3" />
              {t("readOnly")}
            </Badge>
          )}
        </div>
        <span className="truncate text-[11px] text-muted-foreground">{file.absPath}</span>
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {file.exists
          ? format.number(file.bytes ?? 0, { notation: "compact", unit: "byte" })
          : t("notCreated")}
      </span>
    </button>
  )
}
