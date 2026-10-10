"use client"

/**
 * The Files panel's "Shared as network drive" section (ADR-0222 §7.5): this
 * conversation's live shares on the host its files live on, the button that
 * starts a new one, and the dialog it opens.
 *
 * The panel reads the host (`useLiveFileShare`) because its rows need to know
 * whether live sharing is offered at all; this section renders what that read
 * found. A host that cannot share live (`file_share_unavailable`, or one too
 * old to know the commands) gets no section: there is nothing to manage and
 * nothing to turn on from here.
 */

import { useTranslations } from "next-intl"
import { HardDriveIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { LiveFileShareState } from "@/hooks/filespace/use-live-file-share"
import type { FileSpaceDexieListing } from "@/lib/filespace/sources"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"

import { LiveGrantsList } from "./live-grants-list"
import { LiveShareDialog, liveShareBlock } from "./live-share-dialog"

/** One request to open the dialog; `seq` remounts it with this selection. */
export interface LiveShareRequest {
  seq: number
  paths: FileSpacePath[]
}

/** Whether the host can share live at all, so the section and row buttons exist. */
export function liveSharingSupported(live: LiveFileShareState): boolean {
  return live.error !== "file_share_unavailable" && live.error !== "unknown_command"
}

/** Whether a new share can be started from here right now. */
export function liveSharingOffered(live: LiveFileShareState): boolean {
  return live.status !== null && liveShareBlock(live.status) === null
}

export interface LiveSharingSectionProps {
  live: LiveFileShareState
  space: ConversationFileSpace
  dexie: FileSpaceDexieListing
  request: LiveShareRequest | null
  onRequest: (paths: FileSpacePath[]) => void
  onCloseRequest: () => void
}

export function LiveSharingSection({
  live,
  space,
  dexie,
  request,
  onRequest,
  onCloseRequest,
}: LiveSharingSectionProps) {
  const t = useTranslations("liveShare")
  if (!liveSharingSupported(live)) return null
  const block = live.status ? liveShareBlock(live.status) : null

  return (
    <section
      className="border-b px-3 py-2 last:border-b-0"
      aria-labelledby="filespace-live-sharing"
      data-testid="filespace-live-sharing"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3
          id="filespace-live-sharing"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("grants.title")}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={!liveSharingOffered(live)}
          title={block ? t(`dialog.blocked.${block}`) : undefined}
          onClick={() => onRequest([])}
        >
          <HardDriveIcon className="size-3.5" aria-hidden />
          {t("grants.newShare")}
        </Button>
      </div>
      {live.error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${live.error}`, { message: live.errorMessage ?? "" })}
        </p>
      ) : live.status === null ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <LiveGrantsList
          grants={live.grants}
          status={live.status}
          hostId={space.hostId}
          onChanged={live.reload}
        />
      )}
      {request && live.status ? (
        <LiveShareDialog
          key={request.seq}
          open
          onOpenChange={(open) => {
            if (!open) onCloseRequest()
          }}
          space={space}
          dexie={dexie}
          status={live.status}
          initialSelection={request.paths}
          onCreated={live.reload}
        />
      ) : null}
    </section>
  )
}
