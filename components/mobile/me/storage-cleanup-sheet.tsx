"use client"

/**
 * Mobile-native cleanup sheet for `/me/storage`. Desktop exposes cleanup via a
 * 3-tab Dialog (`components/data/storage/storage-cleanup-dialog.tsx`); on mobile
 * we surface the two safe one-tap presets as a bottom sheet and reuse the same
 * `useStorageCleanup` helpers, so there is a single cleanup implementation.
 *
 *   - Quick → `quickCleanup()`  (TTS caches + transient buckets, always safe)
 *   - Deep  → `deepCleanup()`   (also drops messages / backups older than 7d)
 */

import { useTranslations } from "next-intl"
import { SparklesIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useStorageCleanup } from "@/hooks/storage/use-storage-cleanup"
import { StorageManager } from "@/lib/storage"

export interface StorageCleanupSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Notified after a successful cleanup so the page can refresh its stats. */
  onCleaned?: () => void
}

export function StorageCleanupSheet({ open, onOpenChange, onCleaned }: StorageCleanupSheetProps) {
  const t = useTranslations("mobile.me.storage")
  const { quick, deep, isRunning } = useStorageCleanup()

  const run = async (mode: "quick" | "deep") => {
    try {
      const result = mode === "quick" ? await quick() : await deep()
      toast.success(t("cleanupFreedToast", { freed: StorageManager.formatBytes(result.freedSpace) }))
      onCleaned?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="safe-area-pb" data-testid="storage-cleanup-sheet">
        <SheetHeader>
          <SheetTitle>{t("cleanupTitle")}</SheetTitle>
          <SheetDescription>{t("cleanupDescription")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <CleanupOption
            icon={<SparklesIcon className="size-5" aria-hidden="true" />}
            title={t("cleanupQuickTitle")}
            description={t("cleanupQuickDescription")}
            disabled={isRunning}
            onClick={() => void run("quick")}
            testid="storage-cleanup-quick"
          />
          <CleanupOption
            icon={<Trash2Icon className="size-5" aria-hidden="true" />}
            title={t("cleanupDeepTitle")}
            description={t("cleanupDeepDescription")}
            destructive
            disabled={isRunning}
            onClick={() => void run("deep")}
            testid="storage-cleanup-deep"
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface CleanupOptionProps {
  icon: React.ReactNode
  title: string
  description: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
  testid: string
}

function CleanupOption({
  icon,
  title,
  description,
  destructive,
  disabled,
  onClick,
  testid,
}: CleanupOptionProps) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      data-testid={testid}
      className="h-auto items-start justify-start gap-3 whitespace-normal py-3 text-left"
    >
      <span className={destructive ? "mt-0.5 text-destructive" : "mt-0.5 text-primary"}>{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs font-normal text-muted-foreground">{description}</span>
      </span>
    </Button>
  )
}
