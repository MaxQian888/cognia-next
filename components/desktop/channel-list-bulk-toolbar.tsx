"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Link2Icon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
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
import { Button, buttonVariants } from "@/components/ui/button"

export interface ChannelListBulkToolbarProps {
  count: number
  /** When true the selection lives in the Archived view → show Unarchive only. */
  archived?: boolean
  onDelete: () => void | Promise<void>
  onPin: () => void | Promise<void>
  onUnpin: () => void | Promise<void>
  onArchive: () => void | Promise<void>
  onUnarchive: () => void | Promise<void>
  onShare: () => void
  onClear: () => void
}

/**
 * Toolbar that appears above the channel list while a multi-selection is
 * active. Mirrors the file-manager pattern: a count, the destructive action
 * gated by an AlertDialog, plus the batchable per-row toggles (pin/unpin),
 * and a way to dismiss the selection.
 */
export function ChannelListBulkToolbar({
  count,
  archived = false,
  onDelete,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onShare,
  onClear,
}: ChannelListBulkToolbarProps) {
  const t = useTranslations("desktop.channelList.bulk")
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <div
      role="toolbar"
      aria-label={t("selectedCount", { count })}
      className="flex items-center gap-0.5 border-b bg-muted/40 px-2 py-1 text-xs"
    >
      <span
        className="min-w-0 truncate text-muted-foreground"
        title={t("selectedCount", { count })}
      >
        {t("selectedCount", { count })}
      </span>
      {/* Icon-only buttons keep the toolbar inside the 256px channel-list
          column without overflowing or wrapping. Each button has both an
          aria-label (a11y) and a title (hover tooltip) so the meaning is
          still discoverable. */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={onShare}
          aria-label={t("share")}
          title={t("share")}
        >
          <Link2Icon className="size-3.5" />
        </Button>
        {archived ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={() => void onUnarchive()}
            aria-label={t("unarchive")}
            title={t("unarchive")}
          >
            <ArchiveRestoreIcon className="size-3.5" />
          </Button>
        ) : (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={() => void onPin()}
              aria-label={t("pin")}
              title={t("pin")}
            >
              <PinIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={() => void onUnpin()}
              aria-label={t("unpin")}
              title={t("unpin")}
            >
              <PinOffIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={() => void onArchive()}
              aria-label={t("archive")}
              title={t("archive")}
            >
              <ArchiveIcon className="size-3.5" />
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-6 text-destructive hover:text-destructive"
          onClick={() => setConfirmOpen(true)}
          aria-label={t("delete")}
          title={t("delete")}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={onClear}
          aria-label={t("cancel")}
          title={t("cancel")}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-[90vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle", { count })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full sm:w-auto">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({
                variant: "destructive",
                className: "w-full sm:w-auto",
              })}
              onClick={() => {
                setConfirmOpen(false)
                void onDelete()
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
