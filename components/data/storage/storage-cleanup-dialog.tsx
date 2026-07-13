"use client"

// 3-tab cleanup dialog: Quick / Custom (preview-then-confirm) / Deep. Adapted
// from D:\Project\Cognia\components\settings\data\storage-cleanup-dialog.tsx
// — the tab UI and confirm/result flow are direct ports; the categories list
// is filtered through `selectableCategories` from `lib/storage` so users only
// see buckets that are safe to clear.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  EyeIcon,
  Loader2Icon,
  SparklesIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useStorageCleanup } from "@/hooks/storage"
import { CATEGORY_INFO, defaultDisplayName, selectableCategories } from "@/lib/storage"
import type { CleanupResult, StorageCategory } from "@/lib/storage"
import { createLogger } from "@cognia/logging"

const log = createLogger("data-cleanup")

interface StorageCleanupDialogProps {
  trigger?: React.ReactNode
  formatBytes: (bytes: number) => string
  onCleanupComplete?: () => void
}

export function StorageCleanupDialog({
  trigger,
  formatBytes,
  onCleanupComplete,
}: StorageCleanupDialogProps) {
  const t = useTranslations("settings.data.cleanup")
  const tCommon = useTranslations("common")
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<StorageCategory[]>([])
  const [previewResult, setPreviewResult] = useState<CleanupResult | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const [step, setStep] = useState<"select" | "preview" | "result">("select")

  const { cleanup, preview, quick, deep, isRunning } = useStorageCleanup()

  const categories = selectableCategories()

  const toggle = (cat: StorageCategory) =>
    setSelected((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]))

  const onPreview = async () => {
    log.info("cleanup-start", { mode: "preview", categories: selected })
    try {
      const result = await preview({
        categories: selected.length > 0 ? selected : undefined,
      })
      log.info("cleanup-done", {
        mode: "preview",
        freedSpace: result.freedSpace,
        deletedItems: result.deletedItems,
        errors: result.errors,
      })
      setPreviewResult(result)
      setStep("preview")
    } catch (error) {
      log.error("cleanup-failed", { mode: "preview", error })
      throw error
    }
  }

  const onCleanup = async () => {
    log.info("cleanup-start", { mode: "custom", categories: selected })
    try {
      const result = await cleanup({
        categories: selected.length > 0 ? selected : undefined,
      })
      log.info("cleanup-done", {
        mode: "custom",
        freedSpace: result.freedSpace,
        deletedItems: result.deletedItems,
        errors: result.errors,
      })
      setCleanupResult(result)
      setStep("result")
      onCleanupComplete?.()
    } catch (error) {
      log.error("cleanup-failed", { mode: "custom", error })
      throw error
    }
  }

  const onQuick = async () => {
    log.info("cleanup-start", { mode: "quick" })
    try {
      const result = await quick()
      log.info("cleanup-done", {
        mode: "quick",
        freedSpace: result.freedSpace,
        deletedItems: result.deletedItems,
        errors: result.errors,
      })
      setCleanupResult(result)
      setStep("result")
      onCleanupComplete?.()
    } catch (error) {
      log.error("cleanup-failed", { mode: "quick", error })
      throw error
    }
  }

  const onDeep = async () => {
    log.info("cleanup-start", { mode: "deep" })
    try {
      const result = await deep()
      log.info("cleanup-done", {
        mode: "deep",
        freedSpace: result.freedSpace,
        deletedItems: result.deletedItems,
        errors: result.errors,
      })
      setCleanupResult(result)
      setStep("result")
      onCleanupComplete?.()
    } catch (error) {
      log.error("cleanup-failed", { mode: "deep", error })
      throw error
    }
  }

  const onClose = () => {
    setOpen(false)
    // Reset on close so the next open starts at "select".
    setTimeout(() => {
      setStep("select")
      setPreviewResult(null)
      setCleanupResult(null)
      setSelected([])
    }, 200)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : onClose())}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <Trash2Icon className="mr-1.5 size-3.5" />
            {t("button")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("desc")}</DialogDescription>
        </DialogHeader>

        {step === "select" && (
          <Tabs defaultValue="quick" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="quick" className="text-xs">
                <ZapIcon className="mr-1 size-3" />
                {t("tabs.quick")}
              </TabsTrigger>
              <TabsTrigger value="custom" className="text-xs">
                <SparklesIcon className="mr-1 size-3" />
                {t("tabs.custom")}
              </TabsTrigger>
              <TabsTrigger value="deep" className="text-xs">
                <Trash2Icon className="mr-1 size-3" />
                {t("tabs.deep")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="quick" className="space-y-3 pt-3">
              <p className="text-xs text-muted-foreground">{t("quickDesc")}</p>
              <Button onClick={() => void onQuick()} disabled={isRunning} className="w-full">
                {isRunning ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : (
                  <ZapIcon className="mr-2 size-4" />
                )}
                {t("runQuick")}
              </Button>
            </TabsContent>

            <TabsContent value="custom" className="space-y-3 pt-3">
              <p className="text-xs text-muted-foreground">{t("customDesc")}</p>
              <ScrollArea className="h-48 rounded-md border p-2">
                <div className="space-y-2">
                  {categories.map((category) => (
                    <div key={category} className="flex items-center space-x-2">
                      <Checkbox
                        id={category}
                        checked={selected.includes(category)}
                        onCheckedChange={() => toggle(category)}
                      />
                      <Label htmlFor={category} className="cursor-pointer text-xs font-normal">
                        {CATEGORY_INFO[category]?.defaultName ?? defaultDisplayName(category)}
                      </Label>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void onPreview()}
                  disabled={isRunning}
                  className="flex-1"
                >
                  <EyeIcon className="mr-2 size-4" />
                  {t("preview")}
                </Button>
                <Button onClick={() => void onCleanup()} disabled={isRunning} className="flex-1">
                  {isRunning ? (
                    <Loader2Icon className="mr-2 size-4 animate-spin" />
                  ) : (
                    <SparklesIcon className="mr-2 size-4" />
                  )}
                  {t("button")}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="deep" className="space-y-3 pt-3">
              <p className="text-xs text-muted-foreground">{t("deepDesc")}</p>
              <div className="rounded-md border border-yellow-500/50 bg-yellow-500/5 p-2 text-xs">
                <AlertCircleIcon className="mr-1 inline-block size-3 text-yellow-500" />
                {t("deepWarning")}
              </div>
              <Button
                variant="destructive"
                onClick={() => void onDeep()}
                disabled={isRunning}
                className="w-full"
              >
                {isRunning ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : (
                  <Trash2Icon className="mr-2 size-4" />
                )}
                {t("runDeep")}
              </Button>
            </TabsContent>
          </Tabs>
        )}

        {step === "preview" && previewResult && (
          <div className="space-y-3">
            <div className="text-center">
              <p className="text-2xl font-bold">{formatBytes(previewResult.freedSpace)}</p>
              <p className="text-xs text-muted-foreground">{t("willBeFreed")}</p>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("itemsWillBeDeleted", { count: previewResult.deletedItems })}
            </div>
            <ScrollArea className="h-32 rounded-md border p-2">
              {previewResult.details.map((detail) => (
                <div key={detail.category} className="flex justify-between py-1 text-xs">
                  <span>{defaultDisplayName(detail.category)}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {detail.deletedItems}
                  </Badge>
                </div>
              ))}
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("select")}>
                {t("back")}
              </Button>
              <Button onClick={() => void onCleanup()} disabled={isRunning}>
                {isRunning ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : (
                  <Trash2Icon className="mr-2 size-4" />
                )}
                {t("confirm")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "result" && cleanupResult && (
          <div className="space-y-3">
            <div className="text-center">
              <CheckCircle2Icon className="mx-auto mb-2 size-12 text-green-500" />
              <p className="text-lg font-bold">{t("complete")}</p>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex justify-between text-sm">
                <span>{t("freedSpace")}</span>
                <span className="font-medium text-green-600">
                  {formatBytes(cleanupResult.freedSpace)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span>{t("deletedItems")}</span>
                <span className="font-medium">{cleanupResult.deletedItems}</span>
              </div>
            </div>
            {cleanupResult.errors.length > 0 && (
              <div className="text-xs text-yellow-600">
                {t("errors", { count: cleanupResult.errors.length })}
              </div>
            )}
            <DialogFooter>
              <Button onClick={onClose}>{t("done") ?? tCommon("done")}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
