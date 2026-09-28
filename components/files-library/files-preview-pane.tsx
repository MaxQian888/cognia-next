"use client"

/**
 * The Files inspector: a live preview of the selected entry, its details, the
 * conversations it appears in, and its primary actions.
 */

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"
import {
  DownloadIcon,
  MessageSquarePlusIcon,
  SquareArrowOutUpRightIcon,
  StarIcon,
  XIcon,
} from "lucide-react"

import { ArtifactPreview } from "@/components/artifacts/artifact-preview"
import { FilePartPreview } from "@/components/chat/message-parts/file-part-preview"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import { getSessionsByIds } from "@/lib/db/sessions"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { goToSession } from "@/lib/files-library/open"
import type { FilesEntry } from "@/lib/files-library/types"
import { formatBytes } from "@/lib/storage/usage"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useRouter } from "next/navigation"
import { FilesImageThumb } from "./files-image-thumb"

export interface FilesPreviewPaneProps {
  entry: FilesEntry
  actions: FilesActions
  onClose: () => void
}

export function FilesPreviewPane({ entry, actions, onClose }: FilesPreviewPaneProps) {
  const t = useTranslations("files")
  const format = useFormatter()
  const router = useRouter()
  const title = displayTitle(entry, t)
  const sessions = useClientLiveQuery(
    () => getSessionsByIds(entry.sessionIds),
    [entry.sessionIds.join("\n")],
    []
  )

  return (
    <aside
      className="flex h-full min-h-0 flex-col"
      aria-label={t("preview.label")}
      data-testid="files-preview"
    >
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" title={title}>
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{t(`kinds.${entry.kind}`)}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label={t("preview.close")}
          data-testid="files-preview-close"
        >
          <XIcon className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          <PreviewBody entry={entry} title={title} />
        </div>

        {!entry.originAlive ? (
          <p
            className="mx-4 mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
            data-testid="files-preview-source-deleted"
          >
            {t("preview.sourceDeleted")}
          </p>
        ) : null}

        <dl className="mx-4 mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("preview.details.type")}</dt>
          <dd className="truncate">
            {entry.mediaType ?? entry.subtype ?? t(`kinds.${entry.kind}`)}
          </dd>
          {entry.language ? (
            <>
              <dt className="text-muted-foreground">{t("preview.details.language")}</dt>
              <dd>{entry.language}</dd>
            </>
          ) : null}
          {entry.byteSize !== undefined ? (
            <>
              <dt className="text-muted-foreground">{t("preview.details.size")}</dt>
              <dd>{formatBytes(entry.byteSize)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("preview.details.added")}</dt>
          <dd>{format.dateTime(entry.createdAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
          <dt className="text-muted-foreground">{t("preview.details.modified")}</dt>
          <dd>{format.dateTime(entry.updatedAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </dl>

        {sessions && sessions.length > 0 ? (
          <section className="mx-4 mb-4">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              {t("preview.conversations")}
            </h3>
            <ul className="flex flex-col gap-1">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-accent/50"
                    onClick={() => void goToSession(session.id, router)}
                    title={t("preview.openConversation")}
                    data-testid={`files-preview-session-${session.id}`}
                  >
                    {session.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-t p-3">
        <Button size="sm" onClick={() => void actions.open(entry)} data-testid="files-preview-open">
          <SquareArrowOutUpRightIcon aria-hidden />
          {t("actions.open")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void actions.useInChat(entry)}
          data-testid="files-preview-use"
        >
          <MessageSquarePlusIcon aria-hidden />
          {t("actions.useInChat")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void actions.download(entry)}
          data-testid="files-preview-download"
        >
          <DownloadIcon aria-hidden />
          {t("actions.download")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void actions.toggleFavorite(entry)}
          aria-pressed={entry.favoritedAt !== undefined}
          data-testid="files-preview-favorite"
        >
          <StarIcon
            className={
              entry.favoritedAt !== undefined ? "fill-amber-400 text-amber-400" : undefined
            }
            aria-hidden
          />
          {entry.favoritedAt !== undefined ? t("actions.unfavorite") : t("actions.favorite")}
        </Button>
      </div>
    </aside>
  )
}

function PreviewBody({ entry, title }: { entry: FilesEntry; title: string }) {
  const artifact = useArtifactStore((s) =>
    entry.kind === "artifact" ? s.artifacts[entry.sourceId] : undefined
  )
  if (entry.kind === "image") {
    return (
      <FilesImageThumb
        hash={entry.sourceId}
        alt={title}
        full
        className="max-h-[60vh] w-full rounded-md object-contain"
      />
    )
  }
  if (entry.kind === "artifact") {
    return artifact ? (
      <ArtifactPreview artifact={artifact} className="max-h-[60vh]" />
    ) : (
      <Unavailable />
    )
  }
  return <BlobPreview entry={entry} />
}

/** Canvas documents and uploads: the bytes as an object URL, rendered by the chat file preview. */
function BlobPreview({ entry }: { entry: FilesEntry }) {
  const t = useTranslations("files.preview")
  const canvas = useArtifactStore((s) =>
    entry.kind === "canvas" ? s.canvasDocuments[entry.sourceId] : undefined
  )
  const [state, setState] = useState<
    | { key: string; url: string; filename: string; mediaType: string }
    | { key: string; missing: true }
    | null
  >(null)
  const sourceKey = `${entry.key}|${entry.updatedAt}|${canvas?.content.length ?? ""}`

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    void downloadPayloadFor(entry)
      .then((payload) => {
        if (cancelled) return
        if (!payload) {
          setState({ key: sourceKey, missing: true })
          return
        }
        url = URL.createObjectURL(payload.blob)
        setState({
          key: sourceKey,
          url,
          filename: payload.filename,
          mediaType:
            entry.mediaType ??
            (canvas?.language === "markdown" ? "text/markdown" : payload.blob.type),
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        loggers.store.warn("files preview failed", { key: entry.key, error: String(error) })
        setState({ key: sourceKey, missing: true })
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // `sourceKey` captures every input that changes the payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  if (!state || state.key !== sourceKey) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="files-preview-loading">
        {t("loading")}
      </p>
    )
  }
  if ("missing" in state) return <Unavailable />
  return <FilePartPreview url={state.url} mediaType={state.mediaType} filename={state.filename} />
}

function Unavailable() {
  const t = useTranslations("files.preview")
  return (
    <p className="text-sm text-muted-foreground" data-testid="files-preview-unavailable">
      {t("unavailable")}
    </p>
  )
}
