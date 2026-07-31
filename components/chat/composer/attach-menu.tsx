"use client"

// The composer's `+` — everything you can attach to a turn, behind one trigger.
//
// Turn capabilities (Enhance, web search, Skills) share this trigger. The
// mobile composer injects the same capability group into `ComposerPlusMenu`,
// so placement stays consistent across platforms.
//
// A Popover, not a DropdownMenu, so the panel composes with the nested dialogs
// the attach branches raise (the large-folder confirm) without fighting Radix's
// DismissableLayer stack.
//
// Files and screenshots go through the inline attachment model; a folder goes
// through the native directory dialog into `referencedPaths` (reference model —
// the agent reads on demand). Large folders prompt a confirm first (warn +
// confirm, never silently pull a huge tree). Off desktop there is no real
// filesystem path to reference and no screen to capture, so those branches drop
// out.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CameraIcon, FilePlusIcon, FolderPlusIcon, PlusIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { usePlatform } from "@/hooks/use-platform"
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input"
import { captureScreenshot } from "@/lib/ui/screenshot"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
  /** Turn capabilities colocated under the same `+` trigger. */
  capabilities?: React.ReactNode
  className?: string
}

export function ComposerAttachMenu({
  disabled,
  onPickFiles,
  capabilities,
  className,
}: ComposerAttachMenuProps) {
  const t = useTranslations("chat.composer")
  const isDesktop = usePlatform() === "tauri"
  const addReferencedPath = useChatStore((s) => s.addReferencedPath)
  const attachments = usePromptInputAttachments()
  const [pending, setPending] = useState<FolderSummary | null>(null)
  const [open, setOpen] = useState(false)

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

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                aria-label={t("attachMenu.trigger")}
                className={triggerClassName}
                data-testid="composer-attach-menu"
                disabled={disabled}
                size="icon"
                type="button"
                variant="ghost"
              >
                <PlusIcon className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("attachMenu.trigger")}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-56 p-1">
          <PanelLabel>{t("attachMenu.attachGroup")}</PanelLabel>
          <PanelItem
            icon={<FilePlusIcon className="size-4" />}
            label={t("attachMenu.file")}
            onSelect={() => {
              setOpen(false)
              onPickFiles()
            }}
          />
          {isDesktop && (
            <>
              <PanelItem
                icon={<FolderPlusIcon className="size-4" />}
                label={t("attachMenu.folder")}
                onSelect={() => {
                  setOpen(false)
                  void onPickFolder()
                }}
              />
              <PanelItem
                icon={<CameraIcon className="size-4" />}
                label={t("screenshot.captureTooltip")}
                onSelect={() => {
                  setOpen(false)
                  void onScreenshot()
                }}
              />
            </>
          )}

          {capabilities ? (
            <>
              <PanelLabel className="mt-1 border-t border-border pt-2">
                {t("attachMenu.capabilitiesGroup")}
              </PanelLabel>
              <div className="flex flex-wrap items-center gap-2 px-2 pb-1">{capabilities}</div>
            </>
          ) : null}
        </PopoverContent>
      </Popover>

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

function PanelLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground",
        className
      )}
    >
      {children}
    </p>
  )
}

function PanelItem({
  icon,
  label,
  onSelect,
  active,
}: {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
        active && "text-foreground"
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {active && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
    </button>
  )
}
