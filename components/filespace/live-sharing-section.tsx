"use client"

/**
 * The Files panel's "Shared as network drive" section (ADR-0222 §7.5): this
 * conversation's live shares on the host its files live on, the button that
 * starts a new one, and the dialog it opens.
 *
 * In a shared conversation it also shows whether the members are being
 * served (`CollabHostStatusBlock`).
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
import type { SharedSessionScope } from "@/hooks/collab/use-shared-session-members"
import type { LiveFileShareState } from "@/hooks/filespace/use-live-file-share"
import type { FileSpaceDexieListing } from "@/lib/filespace/sources"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"

import { CollabHostStatusBlock } from "./collab-host-status"
import { LiveGrantsList } from "./live-grants-list"
import { initialAudience, LiveShareDialog, liveShareBlock } from "./live-share-dialog"

/** One request to open the dialog; `seq` remounts it with this selection. */
export interface LiveShareRequest {
  seq: number
  paths: FileSpacePath[]
}

/** Whether the host can share live at all, so the section and row buttons exist. */
export function liveSharingSupported(live: LiveFileShareState): boolean {
  return live.error !== "file_share_unavailable" && live.error !== "unknown_command"
}

/**
 * Whether a new share can be started from here right now: for credential
 * holders, or — in a shared conversation — for its members.
 */
export function liveSharingOffered(live: LiveFileShareState, shared = false): boolean {
  return live.status !== null && initialAudience(live.status, shared) !== null
}

/** Changes whenever a grant is added or changes state, for the members block to read again. */
function grantsKey(live: LiveFileShareState): string {
  return live.grants
    .map((view) => `${view.grant.id}:${view.grant.status}:${view.grant.updatedAt}`)
    .join(",")
}

export interface LiveSharingSectionProps {
  live: LiveFileShareState
  space: ConversationFileSpace
  dexie: FileSpaceDexieListing
  request: LiveShareRequest | null
  onRequest: (paths: FileSpacePath[]) => void
  onCloseRequest: () => void
  /** The shared conversation's counterpart, when it has members to share with. */
  sharedScope?: SharedSessionScope | null
}

export function LiveSharingSection({
  live,
  space,
  dexie,
  request,
  onRequest,
  onCloseRequest,
  sharedScope = null,
}: LiveSharingSectionProps) {
  const t = useTranslations("liveShare")
  if (!liveSharingSupported(live)) return null
  const offered = liveSharingOffered(live, Boolean(sharedScope))
  const block = live.status && !offered ? liveShareBlock(live.status) : null

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
          disabled={!offered}
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
        <>
          {sharedScope ? (
            <CollabHostStatusBlock
              sessionId={space.sessionId}
              hostId={space.hostId}
              refreshKey={grantsKey(live)}
              onEnded={live.reload}
            />
          ) : null}
          <LiveGrantsList
            grants={live.grants}
            status={live.status}
            hostId={space.hostId}
            onChanged={live.reload}
          />
        </>
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
          sharedScope={sharedScope}
        />
      ) : null}
    </section>
  )
}
