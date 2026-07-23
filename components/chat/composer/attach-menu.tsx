"use client"

// Single attachment entry point for the composer. One paperclip replaces the
// former paperclip + folder-picker + screenshot trio — every branch produces
// composer context, so they belong under one trigger. Files and screenshots go
// through the inline attachment model; a folder goes through the native
// directory dialog into `referencedPaths` (reference model — the agent reads on
// demand). Large folders prompt a confirm first (warn + confirm, never silently
// pull a huge tree). Off desktop there is no real filesystem path to reference
// and no screen to capture, so the menu collapses to a plain button that opens
// the file dialog directly.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CameraIcon, FilePlusIcon, FolderPlusIcon, PaperclipIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { usePlatform } from "@/hooks/use-platform"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { loggers } from "@cognia/logging"
import {
  pickFolder,
  summarizeFolder,
  folderReference,
  type FolderSummary,
} from "@/lib/chat/folder-context"
import { cn } from "@/lib/utils"

export interface ComposerAttachMenuProps {
  disabled?: boolean
  /** Opens the composer's hidden `<input type="file">`. */
  onPickFiles: () => void
  className?: string
}

export function ComposerAttachMenu({ disabled, onPickFiles, className }: ComposerAttachMenuProps) {
  const t = useTranslations("chat.composer")
  const isDesktop = usePlatform() === "tauri"
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const attachments = usePromptInputAttachments()
  const [pending, setPending] = useState<FolderSummary | null>(null)

  const triggerClassName = cn("size-9 text-muted-foreground hover:text-foreground", className)

  const add = (summary: FolderSummary) => addReferencedPath(folderReference(summary))

  const onPickFolder = async () => {
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

  // `getDisplayMedia` needs a real screen, so this branch is desktop-only —
  // asking a browser user to share their screen for a chat attachment is noise.
  const onScreenshot = async () => {
    try {
      const file = await captureScreenshot()
      if (!file) return
      attachments.add([file])
    } catch (err) {
      loggers.chat.warn("screenshot capture failed", {
        err: err instanceof Error ? err.message : String(err),
      })
      toast.error(err instanceof Error ? err.message : t("screenshot.captureFailed"))
    }
  }

  // Web / mobile: a one-item menu is pure friction — click straight through.
  if (!isDesktop) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t("ariaAttachImage")}
            className={triggerClassName}
            disabled={disabled}
            onClick={onPickFiles}
            size="icon"
            type="button"
            variant="ghost"
          >
            <PaperclipIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("attachImageTooltip")}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t("attachMenu.trigger")}
                className={triggerClassName}
                data-testid="composer-attach-menu"
                disabled={disabled}
                size="icon"
                type="button"
                variant="ghost"
              >
                <PaperclipIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("attachMenu.trigger")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuItem onSelect={onPickFiles}>
            <FilePlusIcon />
            {t("attachMenu.file")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onPickFolder()}>
            <FolderPlusIcon />
            {t("attachMenu.folder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onScreenshot()}>
            <CameraIcon />
            {t("screenshot.captureTooltip")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("folder.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("folder.confirmBody", {
                count: pending?.fileCount ?? 0,
                name: pending?.relative ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPending(null)}>
              {t("folder.confirmCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) add(pending)
                setPending(null)
              }}
            >
              {t("folder.confirmAdd")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
