"use client"

// Desktop-only folder picker for the composer. Opens the native directory
// dialog, sizes the folder via the gitignore-aware workspace walk, and adds it
// as a reference (agent reads on demand). Large folders prompt a confirm first
// (decision: warn + confirm, never silently pull a huge tree).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderPlusIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { usePlatform } from "@/hooks/use-platform"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { loggers } from "@/lib/logging"
import {
  pickFolder,
  summarizeFolder,
  folderReference,
  type FolderSummary,
} from "@/lib/chat/folder-context"

export interface FolderPickerButtonProps {
  disabled?: boolean
}

export function FolderPickerButton({ disabled }: FolderPickerButtonProps) {
  const t = useTranslations("chat.composer.folder")
  const isDesktop = usePlatform() === "tauri"
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const [pending, setPending] = useState<FolderSummary | null>(null)

  // The reference model needs a real filesystem path; only meaningful on desktop.
  if (!isDesktop) return null

  const add = (summary: FolderSummary) => addReferencedPath(folderReference(summary))

  const onPick = async () => {
    try {
      const dir = await pickFolder()
      if (!dir) return
      const summary = await summarizeFolder(dir)
      if (summary.needsConfirm) {
        setPending(summary)
        return
      }
      add(summary)
    } catch (err) {
      loggers.chat.error("folder pick failed", err)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t("aria")}
            className="size-9 text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => void onPick()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <FolderPlusIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("tooltip")}</TooltipContent>
      </Tooltip>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmBody", {
                count: pending?.fileCount ?? 0,
                name: pending?.relative ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPending(null)}>
              {t("confirmCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) add(pending)
                setPending(null)
              }}
            >
              {t("confirmAdd")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
