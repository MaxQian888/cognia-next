"use client"

/**
 * Destructive memory operations, separated from the settings above them and
 * collapsed by default.
 *
 * The scope selector is the point: `manageMemory({ kind: "clear" })` used to be
 * all-or-nothing, so "my workspace memories are stale" had no answer short of
 * deleting everything the assistant had ever learned. `clearMemories(query)`
 * already supported a filter — only the command dropped it.
 */

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { DatabaseBackupIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { MotionCollapse } from "@/components/chat/motion/motion-reveal"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import type { ListMemoriesQuery } from "@/lib/db/memories"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

/** Which rows a clear should match. */
export type MemoryClearScope = "all" | "global" | "workspace" | "character" | "invalidated"

const CLEAR_SCOPES: readonly MemoryClearScope[] = [
  "all",
  "global",
  "workspace",
  "character",
  "invalidated",
]

/** Exported for the test — the mapping is the whole behavioral surface here. */
export function clearQueryFor(scope: MemoryClearScope): ListMemoriesQuery | undefined {
  switch (scope) {
    case "all":
      // Undefined, not `{}` — `listMemories()` returns active *and* invalidated
      // rows when no status is given, which is what "everything" must mean.
      return undefined
    case "invalidated":
      return { status: "invalidated" }
    default:
      return { scope }
  }
}

export interface MemoryDangerZoneProps {
  /** Opens expanded in tests/stories; defaults to collapsed. */
  defaultOpen?: boolean
}

export function MemoryDangerZone({ defaultOpen = false }: MemoryDangerZoneProps) {
  const t = useTranslations("settings.memory.danger")
  const [open, setOpen] = useState(defaultOpen)
  const [scope, setScope] = useState<MemoryClearScope>("all")
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <div className="rounded-lg border border-destructive/30 p-3" data-testid="memory-danger-zone">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="h-auto w-full justify-between gap-2 whitespace-normal p-0 text-left font-normal hover:bg-transparent"
      >
        <span className="text-sm font-medium text-destructive">{t("title")}</span>
        <span className="text-[11px] text-muted-foreground">
          {open ? t("collapse") : t("expand")}
        </span>
      </Button>

      <MotionCollapse open={open}>
        <div className="space-y-3 pt-3">
          <p className="text-[11px] text-muted-foreground">{t("description")}</p>

          <div className="space-y-1.5">
            <Label htmlFor="memory-clear-scope" className="text-xs">
              {t("scope.label")}
            </Label>
            <Select value={scope} onValueChange={(v) => setScope(v as MemoryClearScope)}>
              <SelectTrigger
                id="memory-clear-scope"
                className="w-full sm:w-72"
                aria-label={t("scope.label")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLEAR_SCOPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`scope.options.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings?section=data">
                <DatabaseBackupIcon className="size-3.5" />
                {t("backupFirst")}
              </Link>
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
              <Trash2Icon className="size-3.5" />
              {t("clear")}
            </Button>
          </div>
        </div>
      </MotionCollapse>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.title")}
        description={t(`confirm.descriptions.${scope}`)}
        confirmLabel={t("confirm.confirm")}
        cancelLabel={t("confirm.cancel")}
        tone="destructive"
        onConfirm={async () => {
          const result = await manageMemory({ kind: "clear", query: clearQueryFor(scope) })
          if (result.ok) {
            toast.success(t("cleared", { count: result.clearedCount ?? 0 }))
          } else {
            toast.error(t("clearFailed"))
          }
        }}
      />
    </div>
  )
}
