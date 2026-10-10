"use client"

/**
 * The dock's Conversation files panel (ADR-0222 §2): one conversation's
 * FileSpace — its working directory, its other roots, its uploads and its
 * artifacts — in one list, each row addressable by a copyable link.
 *
 * It browses nothing itself. A directory opens in the dock's workspace editor
 * rooted at that mount, an artifact in the artifact surface, an upload as a
 * download; the panel's job is to show what belongs to the conversation and
 * where it actually lives (host path, sandbox path, worktree or checkout,
 * reachable or not).
 *
 * "Share files…" (and each row's share action, with that row preselected)
 * opens the share dialog on a `file-bundle`: the files and nothing else.
 *
 * Where the host can share live (ADR-0222 §7.5), each row also offers "share
 * as a network drive", and the "Shared as network drive" section lists the
 * conversation's live shares with their controls.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  HardDriveIcon,
  LinkIcon,
  ServerIcon,
  Share2Icon,
  SparklesIcon,
} from "lucide-react"

import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConversationFileSpace } from "@/hooks/filespace/use-conversation-filespace"
import { useLiveFileShare } from "@/hooks/filespace/use-live-file-share"
import { getSessionAsset } from "@/lib/db/session-assets"
import { getSession } from "@/lib/db/sessions"
import { downloadBlob } from "@/lib/files/download"
import { buildConversationFilesLink } from "@/lib/filespace/links"
import { OPEN_FAILURE_MESSAGE_KEY } from "@/lib/filespace/messages"
import { openFileSpacePath } from "@/lib/filespace/open"
import { isFileSpacePathWithin, normalizeFileSpacePath } from "@/lib/filespace/paths"
import { LOCAL_FILESPACE_HOST_ID } from "@/lib/filespace/resolve"
import { fileBundlePayload } from "@/lib/share/payload"
import { formatBytes } from "@/lib/storage/usage"
import { isTauri } from "@/lib/tauri"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { cn } from "@/lib/utils"
import { useFileSpacePanelStore } from "@/stores/filespace/filespace-panel-store"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  LiveSharingSection,
  liveSharingOffered,
  type LiveShareRequest,
} from "./live-sharing-section"
import type {
  FileSpaceDexieEntry,
  FileSpaceMount,
  FileSpaceMountStatusReason,
  FileSpacePath,
} from "@/types/filespace"

export interface ConversationFilesPanelProps {
  sessionId: string | null
}

/** One opening of the share dialog; `seq` remounts it with this selection. */
interface ShareRequest {
  seq: number
  session: ChatSession
  initialSelection: FileSpacePath[]
}

const REASON_KEY: Record<FileSpaceMountStatusReason, string> = {
  "no-fs-backend": "noFsBackend",
  "host-offline": "hostOffline",
  "managed-missing-on-device": "managedMissingOnDevice",
  "managed-deleted": "managedDeleted",
}

export function ConversationFilesPanel({ sessionId }: ConversationFilesPanelProps) {
  const t = useTranslations("filespace")
  const loaded = useConversationFileSpace(sessionId)
  const focus = useFileSpacePanelStore((state) => state.focus)
  const consumeFocus = useFileSpacePanelStore((state) => state.consumeFocus)
  const [highlight, setHighlight] = useState<FileSpacePath | null>(null)
  const [shareRequest, setShareRequest] = useState<ShareRequest | null>(null)
  const [liveRequest, setLiveRequest] = useState<LiveShareRequest | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const live = useLiveFileShare({
    sessionId,
    hostId: loaded?.space.hostId,
    enabled: Boolean(sessionId && loaded && loaded.space.status !== "deleted"),
  })

  // Apply a focus request aimed at this conversation once its rows exist;
  // one aimed at another conversation is left for that conversation's panel.
  useEffect(() => {
    if (!focus || focus.sessionId !== sessionId || !loaded) return
    const target = focus.path
    queueMicrotask(() => {
      setHighlight(target)
      consumeFocus(focus.seq)
    })
  }, [focus, sessionId, loaded, consumeFocus])

  useEffect(() => {
    if (!highlight) return
    const key = rowKeyFor(highlight, loaded?.space.mounts ?? [])
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-filespace-row]") ?? []
    const row = Array.from(rows).find((candidate) => candidate.dataset.filespaceRow === key)
    row?.scrollIntoView?.({ block: "nearest" })
  }, [highlight, loaded])

  if (!sessionId) {
    return (
      <PanelEmpty
        testId="filespace-no-session"
        title={t("panel.noSession.title")}
        description={t("panel.noSession.description")}
      />
    )
  }
  if (loaded === undefined) {
    return (
      <div
        className="space-y-2 p-3"
        data-testid="filespace-loading"
        aria-label={t("panel.loading")}
      >
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (!loaded || loaded.space.status === "deleted") {
    return (
      <PanelEmpty
        testId="filespace-deleted"
        title={t("panel.deleted.title")}
        description={t("panel.deleted.description")}
      />
    )
  }

  const { space, dexie } = loaded
  const diskMounts = space.mounts.filter((mount) => mount.backing === "disk")
  if (space.mounts.length === 0) {
    return (
      <PanelEmpty
        testId="filespace-empty"
        title={t("panel.empty.title")}
        description={t("panel.empty.description")}
      />
    )
  }

  const open = (path: FileSpacePath) => {
    void openFileSpacePath({ sessionId, path }).then((result) => {
      if (result !== "opened") toast.error(t(OPEN_FAILURE_MESSAGE_KEY[result]))
    })
  }
  const copyLink = (path: FileSpacePath) => {
    const link = buildConversationFilesLink({ sessionId, path }, { desktop: isTauri() })
    void writeClipboardText(link).then(
      () => toast.success(t("toast.linkCopied")),
      () => toast.error(t("toast.copyFailed"))
    )
  }
  // The session is read when sharing starts, so the dialog's collaboration
  // check sees the conversation as it is now, not as it was when the panel
  // mounted.
  const share = (initialSelection: FileSpacePath[]) => {
    void getSession(sessionId).then(
      (session) => {
        if (!session) {
          toast.error(t("toast.shareUnavailable"))
          return
        }
        setShareRequest((previous) => ({
          seq: (previous?.seq ?? 0) + 1,
          session,
          initialSelection,
        }))
      },
      () => toast.error(t("toast.shareUnavailable"))
    )
  }
  // Only offered where the host would issue a grant; the section says why not.
  const shareLive = liveSharingOffered(live)
    ? (paths: FileSpacePath[]) =>
        setLiveRequest((previous) => ({ seq: (previous?.seq ?? 0) + 1, paths }))
    : undefined
  const download = (entry: FileSpaceDexieEntry) => {
    void getSessionAsset(sessionId, entry.sourceId)
      .then((source) => {
        if (!source) {
          toast.error(t("toast.downloadUnavailable"))
          return
        }
        downloadBlob(source.blob, source.filename)
      })
      .catch(() => toast.error(t("toast.downloadFailed")))
  }

  const focusedDiskPath =
    highlight && diskMounts.some((mount) => isWithinMount(highlight, mount)) ? highlight : null

  return (
    <div
      className="flex h-full flex-col overflow-y-auto"
      ref={listRef}
      data-testid="filespace-panel"
    >
      <div className="flex items-center justify-end border-b px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => share([])}
        >
          <Share2Icon className="size-3.5" aria-hidden />
          {t("actions.shareFiles")}
        </Button>
      </div>

      {space.hostId !== LOCAL_FILESPACE_HOST_ID ? (
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
          <ServerIcon className="size-3.5" aria-hidden />
          <span data-testid="filespace-host">
            {t("host.remote", { label: space.hostLabel ?? space.hostId })}
          </span>
        </div>
      ) : null}

      {diskMounts.length > 0 ? (
        <Section title={t("section.folders")}>
          {diskMounts.map((mount) => (
            <MountRow
              key={mount.id}
              mount={mount}
              highlighted={highlight !== null && isWithinMount(highlight, mount)}
              focusedPath={
                focusedDiskPath && isWithinMount(focusedDiskPath, mount) ? focusedDiskPath : null
              }
              onOpen={() => open(mount.virtualPath as FileSpacePath)}
              onShare={() => share([mount.virtualPath as FileSpacePath])}
              onShareLive={
                shareLive ? () => shareLive([mount.virtualPath as FileSpacePath]) : undefined
              }
              onCopyLink={() => copyLink(mount.virtualPath as FileSpacePath)}
            />
          ))}
        </Section>
      ) : null}

      {dexie.uploads.length > 0 ? (
        <Section title={t("section.uploads")}>
          {dexie.uploads.map((entry) => (
            <EntryRow
              key={entry.sourceId}
              entry={entry}
              icon={<FileIcon className="size-4" aria-hidden />}
              highlighted={highlight === entry.path}
              primaryAction={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={!entry.sourceAvailable}
                  aria-label={t("actions.download")}
                  title={
                    entry.sourceAvailable ? t("actions.download") : t("entry.sourceUnavailable")
                  }
                  onClick={() => download(entry)}
                >
                  <DownloadIcon className="size-3.5" />
                </Button>
              }
              onShare={entry.sourceAvailable ? () => share([entry.path]) : undefined}
              onShareLive={
                entry.sourceAvailable && shareLive ? () => shareLive([entry.path]) : undefined
              }
              onCopyLink={() => copyLink(entry.path)}
            />
          ))}
        </Section>
      ) : null}

      {dexie.artifacts.length > 0 ? (
        <Section title={t("section.artifacts")}>
          {dexie.artifacts.map((entry) => (
            <EntryRow
              key={entry.sourceId}
              entry={entry}
              icon={<SparklesIcon className="size-4" aria-hidden />}
              highlighted={highlight === entry.path}
              primaryAction={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("actions.open")}
                  title={t("actions.open")}
                  onClick={() => open(entry.path)}
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              }
              onShare={() => share([entry.path])}
              onShareLive={shareLive ? () => shareLive([entry.path]) : undefined}
              onCopyLink={() => copyLink(entry.path)}
            />
          ))}
        </Section>
      ) : null}

      <LiveSharingSection
        live={live}
        space={space}
        dexie={dexie}
        request={liveRequest}
        onRequest={(paths) => shareLive?.(paths)}
        onCloseRequest={() => setLiveRequest(null)}
      />

      {shareRequest ? (
        <ShareLinkDialog
          key={shareRequest.seq}
          open
          onOpenChange={(next) => {
            if (!next) setShareRequest(null)
          }}
          buildPayload={() =>
            fileBundlePayload(
              t("share.bundleTitle", {
                title: shareRequest.session.title || t("share.untitled"),
              })
            )
          }
          files={{
            session: shareRequest.session,
            initialSelection: shareRequest.initialSelection,
            required: true,
          }}
        />
      ) : null}
    </div>
  )
}

/** The row a focused path highlights: its disk mount's row, or its own Dexie row. */
function rowKeyFor(path: FileSpacePath, mounts: readonly FileSpaceMount[]): string {
  const mount = mounts.find(
    (candidate) => candidate.backing === "disk" && isWithinMount(path, candidate)
  )
  return mount ? mount.virtualPath : path
}

function isWithinMount(path: FileSpacePath, mount: FileSpaceMount): boolean {
  const prefix = normalizeFileSpacePath(mount.virtualPath)
  return prefix !== null && isFileSpacePathWithin(path, prefix)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b px-3 py-2 last:border-b-0">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1">{children}</ul>
    </section>
  )
}

function MountRow({
  mount,
  highlighted,
  focusedPath,
  onOpen,
  onShare,
  onShareLive,
  onCopyLink,
}: {
  mount: FileSpaceMount
  highlighted: boolean
  focusedPath: FileSpacePath | null
  onOpen: () => void
  onShare: () => void
  /** Absent where the host does not offer live sharing. */
  onShareLive?: () => void
  onCopyLink: () => void
}) {
  const t = useTranslations("filespace")
  const available = mount.status === "available"
  return (
    <li
      data-filespace-row={mount.virtualPath}
      data-testid={`filespace-mount-${mount.id}`}
      className={cn(
        "rounded-md border px-2 py-1.5",
        highlighted ? "border-primary bg-primary/5" : "border-transparent"
      )}
    >
      <div className="flex items-start gap-2">
        {mount.managed ? (
          <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{mount.label}</span>
            <code className="text-[11px] text-muted-foreground">{mount.virtualPath}</code>
            <Badge variant="outline" className="text-[10px]">
              {mount.role === "primary" ? t("mount.primary") : t("mount.additional")}
            </Badge>
            {mount.managed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="text-[10px]">
                    {t("mount.managed")}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{t("mount.managedHint")}</TooltipContent>
              </Tooltip>
            ) : null}
            {!available ? (
              <Badge
                variant="destructive"
                className="text-[10px]"
                data-testid="filespace-mount-status"
              >
                {t(`status.${mount.status}`)}
              </Badge>
            ) : null}
          </div>
          {mount.hostPath ? (
            <p
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={mount.hostPath}
            >
              {mount.hostPath}
            </p>
          ) : null}
          {mount.containerPath ? (
            <p className="truncate text-[11px] text-muted-foreground">
              {t("mount.container", { path: mount.containerPath })}
            </p>
          ) : null}
          {mount.statusReason ? (
            <p className="text-[11px] text-muted-foreground">
              {t(`reason.${REASON_KEY[mount.statusReason]}`)}
            </p>
          ) : null}
          {focusedPath && focusedPath !== mount.virtualPath ? (
            <p className="truncate text-[11px] text-primary" data-testid="filespace-focused-path">
              {t("panel.focusedPath", { path: focusedPath })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={!available}
            aria-label={t("actions.open")}
            title={t("actions.open")}
            onClick={onOpen}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
          <ShareButton onShare={available && mount.hostPath ? onShare : undefined} />
          {onShareLive ? (
            <ShareLiveButton onShareLive={available && mount.hostPath ? onShareLive : undefined} />
          ) : null}
          <CopyLinkButton onCopy={onCopyLink} />
        </div>
      </div>
    </li>
  )
}

function EntryRow({
  entry,
  icon,
  highlighted,
  primaryAction,
  onShare,
  onShareLive,
  onCopyLink,
}: {
  entry: FileSpaceDexieEntry
  icon: React.ReactNode
  highlighted: boolean
  primaryAction: React.ReactNode
  /** Absent when the row has nothing that could be shared. */
  onShare?: () => void
  /** Absent where the host does not offer live sharing for this row. */
  onShareLive?: () => void
  onCopyLink: () => void
}) {
  const t = useTranslations("filespace")
  const displayName = entry.path.slice(entry.path.lastIndexOf("/") + 1)
  return (
    <li
      data-filespace-row={entry.path}
      data-testid={`filespace-entry-${entry.sourceId}`}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1",
        highlighted ? "border-primary bg-primary/5" : "border-transparent"
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={entry.path}>
          {displayName}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {formatBytes(entry.size)}
          {!entry.sourceAvailable ? ` · ${t("entry.sourceUnavailable")}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        {primaryAction}
        <ShareButton onShare={onShare} />
        {onShareLive ? <ShareLiveButton onShareLive={onShareLive} /> : null}
        <CopyLinkButton onCopy={onCopyLink} />
      </div>
    </li>
  )
}

/** Disabled when `onShare` is absent: the row cannot be read from here. */
function ShareButton({ onShare }: { onShare?: () => void }) {
  const t = useTranslations("filespace")
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      disabled={!onShare}
      aria-label={t("actions.share")}
      title={t("actions.share")}
      onClick={onShare}
    >
      <Share2Icon className="size-3.5" />
    </Button>
  )
}

/** Share this row as a network drive; disabled when the row cannot be served. */
function ShareLiveButton({ onShareLive }: { onShareLive?: () => void }) {
  const t = useTranslations("liveShare")
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      disabled={!onShareLive}
      aria-label={t("grants.newShare")}
      title={t("grants.newShare")}
      onClick={onShareLive}
    >
      <HardDriveIcon className="size-3.5" />
    </Button>
  )
}

function CopyLinkButton({ onCopy }: { onCopy: () => void }) {
  const t = useTranslations("filespace")
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={t("actions.copyLink")}
      title={t("actions.copyLink")}
      onClick={onCopy}
    >
      <LinkIcon className="size-3.5" />
    </Button>
  )
}

function PanelEmpty({
  testId,
  title,
  description,
}: {
  testId: string
  title: string
  description: string
}) {
  return (
    <Empty className="h-full border-0" data-testid={testId}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
