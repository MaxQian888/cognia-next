"use client"

/**
 * The files a share carries (ADR-0222): the whole page for a `file-bundle`,
 * an Attachments block under a shared conversation.
 *
 * Laid out as a list and a preview pane, side by side on wide screens and
 * stacked on narrow ones. Selecting a file shows it in the pane; small
 * previewable files load on selection, larger ones on request.
 *
 * Downloads decrypt in the reader's browser: every chunk is fetched with the
 * read ticket from the envelope read, decrypted with a key derived from the
 * URL fragment (and the passphrase), and checked against the manifest's
 * SHA-256 before the file is handed over. A file is decrypted once and the
 * bytes reused by both the preview and later downloads. Previews use those
 * bytes: images and PDFs through a `blob:` URL whose type is pinned to what
 * the preview expects (so a file labelled PDF can never be rendered as a
 * document of the viewer's origin), SVG not at all, and text as plain text,
 * never as markup.
 *
 * Without `access` (the owner's preview before publishing) or without a read
 * ticket (a server that cannot serve files) the list renders alone, without
 * download actions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ClockIcon,
  DownloadIcon,
  EyeIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderOpenIcon,
  Loader2Icon,
  LockIcon,
  PaperclipIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { downloadBlob } from "@/lib/files/download"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { formatBytes } from "@/lib/perf/backend/format"
import {
  ShareFileIntegrityError,
  ShareFileUnavailableError,
  ShareTicketExpiredError,
  downloadShareBlob,
} from "@/lib/share/blobs"
import type { ShareFilesAccess } from "@/lib/share/load"
import type { ShareFileEntry } from "@/lib/share/types"
import { cn } from "@/lib/utils"

/** Largest text file previewed inline; bigger ones download only. */
export const SHARE_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
/** Largest image or PDF previewed inline. */
export const SHARE_MEDIA_PREVIEW_MAX_BYTES = 64 * 1024 * 1024
/** Largest file whose preview loads as soon as it is selected. */
export const SHARE_AUTO_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

type PreviewKind = "image" | "pdf" | "text"

/** How a file can be previewed in the page, or null when it downloads only. */
export function sharePreviewKind(entry: Pick<ShareFileEntry, "mime" | "size">): PreviewKind | null {
  const mime = entry.mime.toLowerCase()
  // SVG is markup that can carry script; it downloads rather than renders.
  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    return entry.size <= SHARE_MEDIA_PREVIEW_MAX_BYTES ? "image" : null
  }
  if (mime === "application/pdf") return entry.size <= SHARE_MEDIA_PREVIEW_MAX_BYTES ? "pdf" : null
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "text/yaml"
  ) {
    return entry.size <= SHARE_TEXT_PREVIEW_MAX_BYTES ? "text" : null
  }
  return null
}

/** The icon family a file is drawn with. */
export type ShareFileVisual =
  "image" | "pdf" | "code" | "text" | "archive" | "audio" | "video" | "other"

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lua",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
])
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip"])

export function shareFileVisual(entry: Pick<ShareFileEntry, "mime" | "name">): ShareFileVisual {
  const mime = entry.mime.toLowerCase()
  const extension = entry.name.includes(".")
    ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase()
    : ""
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (ARCHIVE_EXTENSIONS.has(extension) || /zip|tar|compressed|archive/.test(mime)) return "archive"
  if (CODE_EXTENSIONS.has(extension)) return "code"
  if (mime.startsWith("text/")) return "text"
  return "other"
}

const VISUALS: Record<ShareFileVisual, { icon: LucideIcon; tone: string }> = {
  image: { icon: FileImageIcon, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  pdf: { icon: FileTextIcon, tone: "bg-red-500/10 text-red-600 dark:text-red-400" },
  code: { icon: FileCodeIcon, tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  text: { icon: FileTextIcon, tone: "bg-slate-500/10 text-slate-600 dark:text-slate-300" },
  archive: { icon: FileArchiveIcon, tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  audio: { icon: FileAudioIcon, tone: "bg-pink-500/10 text-pink-600 dark:text-pink-400" },
  video: { icon: FileVideoIcon, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  other: { icon: FileIcon, tone: "bg-muted text-muted-foreground" },
}

function FileGlyph({ file, size = "sm" }: { file: ShareFileEntry; size?: "sm" | "lg" }) {
  const { icon: Icon, tone } = VISUALS[shareFileVisual(file)]
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-lg",
        size === "lg" ? "size-10" : "size-9",
        tone
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  )
}

/** The folder a file sat in, for the line under its name. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash > 0 ? path.slice(0, slash) : "/"
}

type FileErrorKey = "ticketExpired" | "unavailable" | "integrity" | "failed"

function errorKey(error: unknown): FileErrorKey {
  if (error instanceof ShareTicketExpiredError) return "ticketExpired"
  if (error instanceof ShareFileUnavailableError) return "unavailable"
  if (error instanceof ShareFileIntegrityError) return "integrity"
  return "failed"
}

type FileState =
  | { status: "idle" }
  | { status: "loading"; done: number }
  | { status: "error"; error: FileErrorKey }
  | { status: "ready"; blob: Blob }

const IDLE: FileState = { status: "idle" }

/** Each file decrypted at most once, shared by its row and the preview pane. */
function useShareFileBlobs(access: ShareFilesAccess | undefined) {
  const [states, setStates] = useState<Record<string, FileState>>({})
  const pending = useRef(new Map<string, Promise<Blob>>())
  const ready = useRef(new Map<string, Blob>())

  const fetchFile = useCallback(
    (file: ShareFileEntry): Promise<Blob> => {
      const done = ready.current.get(file.blobId)
      if (done) return Promise.resolve(done)
      const inflight = pending.current.get(file.blobId)
      if (inflight) return inflight
      if (!access?.readTicket) return Promise.reject(new ShareTicketExpiredError())
      const set = (state: FileState) => setStates((all) => ({ ...all, [file.blobId]: state }))
      set({ status: "loading", done: 0 })
      const request = downloadShareBlob({
        baseUrl: access.baseUrl,
        code: access.code,
        readTicket: access.readTicket,
        material: access.material,
        entry: file,
        fetchImpl: proxyFetch,
        onProgress: (bytes) => set({ status: "loading", done: bytes }),
      })
      pending.current.set(file.blobId, request)
      request.then(
        (blob) => {
          pending.current.delete(file.blobId)
          ready.current.set(file.blobId, blob)
          set({ status: "ready", blob })
        },
        (error: unknown) => {
          pending.current.delete(file.blobId)
          set({ status: "error", error: errorKey(error) })
        }
      )
      return request
    },
    [access]
  )

  return { stateOf: (file: ShareFileEntry) => states[file.blobId] ?? IDLE, fetchFile }
}

export function ShareFilesSection({
  files,
  access,
  title,
  variant = "attachments",
  className,
}: {
  files: ShareFileEntry[]
  access?: ShareFilesAccess
  /** The share's title, shown as the page heading of a `file-bundle`. */
  title?: string
  /** `page`: the files are the share. `attachments`: they travel with a conversation. */
  variant?: "page" | "attachments"
  className?: string
}) {
  const t = useTranslations("share.view.files")
  const canDownload = Boolean(access?.readTicket)
  const interactive = canDownload ? access : undefined
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files])
  const ticketDeadline = access?.readTicketExpiresAt
  const deadline = useMemo(
    () => (ticketDeadline ? new Date(ticketDeadline).toLocaleString() : null),
    [ticketDeadline]
  )
  const { stateOf, fetchFile } = useShareFileBlobs(interactive)
  // A file-bundle opens on its first file; attachments wait to be picked.
  const [picked, setPicked] = useState<string | null>(null)
  const selectedId = picked ?? (variant === "page" ? (files[0]?.blobId ?? null) : null)
  const selected = files.find((file) => file.blobId === selectedId) ?? null

  const loadPreview = useCallback(
    (file: ShareFileEntry) => void fetchFile(file).catch(() => undefined),
    [fetchFile]
  )

  const download = async (file: ShareFileEntry) => {
    try {
      await downloadBlob(await fetchFile(file), file.name)
    } catch {
      // The row and the pane already say why.
    }
  }

  const page = variant === "page"
  const heading = page ? title || t("title") : t("attachmentsTitle")
  const summary = t("summary", { count: files.length, size: formatBytes(totalBytes) })
  const Heading = page ? "h1" : "h2"

  return (
    <section
      aria-label={heading}
      className={cn("mx-auto w-full min-w-0", page ? "max-w-6xl" : "max-w-3xl", className)}
    >
      <header className={cn("flex items-start gap-3", page ? "mb-6" : "mb-3")}>
        {page ? (
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <FolderOpenIcon aria-hidden className="size-6" />
          </span>
        ) : (
          <PaperclipIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <Heading
            className={cn(
              "truncate font-semibold tracking-tight",
              page ? "text-xl sm:text-2xl" : "text-sm"
            )}
          >
            {heading}
          </Heading>
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground",
              page ? "mt-1 text-sm" : "mt-0.5 text-xs"
            )}
          >
            <span>{summary}</span>
            {access ? (
              <span className="inline-flex items-center gap-1">
                <LockIcon aria-hidden className="size-3.5" />
                {t("encrypted")}
              </span>
            ) : null}
            {canDownload && deadline ? (
              <span className="inline-flex items-center gap-1">
                <ClockIcon aria-hidden className="size-3.5" />
                {t("availableUntil", { time: deadline })}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {access && !canDownload ? (
        <p className="mb-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {t("noTicket")}
        </p>
      ) : null}

      <div
        className={cn(
          "grid gap-4",
          interactive &&
            (page
              ? "lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
              : "md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]")
        )}
      >
        <ul
          aria-label={t("listLabel")}
          className="h-fit divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
        >
          {files.map((file) => (
            <ShareFileRow
              key={file.blobId}
              file={file}
              state={stateOf(file)}
              selected={interactive ? file.blobId === selectedId : false}
              onSelect={interactive ? () => setPicked(file.blobId) : undefined}
              onDownload={interactive ? () => void download(file) : undefined}
            />
          ))}
        </ul>

        {interactive ? (
          <PreviewPane
            file={selected}
            state={selected ? stateOf(selected) : IDLE}
            onLoad={loadPreview}
            onDownload={(file) => void download(file)}
            tall={page}
          />
        ) : null}
      </div>
    </section>
  )
}

function ShareFileRow({
  file,
  state,
  selected,
  onSelect,
  onDownload,
}: {
  file: ShareFileEntry
  state: FileState
  selected: boolean
  onSelect?: () => void
  onDownload?: () => void
}) {
  const t = useTranslations("share.view.files")
  const percent =
    state.status === "loading" && file.size > 0 ? Math.floor((state.done / file.size) * 100) : 0
  const body = (
    <>
      <FileGlyph file={file} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block truncate text-xs text-muted-foreground" title={file.path}>
          {folderOf(file.path)} · {formatBytes(file.size)}
        </span>
      </span>
    </>
  )
  return (
    <li className={cn("relative", selected && "bg-muted/60")}>
      <div className="flex items-center gap-1 pr-2">
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={t("select", { name: file.name })}
            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">{body}</div>
        )}
        {state.status === "loading" ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" role="status">
            {t("progress", { percent })}
          </span>
        ) : null}
        {onDownload ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            onClick={onDownload}
            disabled={state.status === "loading"}
            aria-label={t("download", { name: file.name })}
            title={t("download", { name: file.name })}
          >
            <DownloadIcon aria-hidden className="size-4" />
          </Button>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <span
            className="block h-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </span>
      ) : null}
      {state.status === "error" ? (
        <p className="px-3 pb-2 pl-15 text-xs text-destructive">{t(`error.${state.error}`)}</p>
      ) : null}
    </li>
  )
}

function PreviewPane({
  file,
  state,
  onLoad,
  onDownload,
  tall,
}: {
  file: ShareFileEntry | null
  state: FileState
  onLoad: (file: ShareFileEntry) => void
  onDownload: (file: ShareFileEntry) => void
  tall: boolean
}) {
  const t = useTranslations("share.view.files")
  const kind = file ? sharePreviewKind(file) : null
  const autoLoad =
    file !== null &&
    kind !== null &&
    state.status === "idle" &&
    file.size <= SHARE_AUTO_PREVIEW_MAX_BYTES

  // Deferred so the fetch's own "loading" state is not set inside the effect body.
  useEffect(() => {
    if (!autoLoad || !file) return
    let active = true
    queueMicrotask(() => {
      if (active) onLoad(file)
    })
    return () => {
      active = false
    }
  }, [autoLoad, file, onLoad])

  const frame = cn(
    "flex min-h-64 flex-col overflow-hidden rounded-xl border border-border bg-card lg:sticky lg:top-4",
    tall && "lg:min-h-[28rem]"
  )

  if (!file) {
    return (
      <div className={frame} aria-label={t("previewRegion")} role="region">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
          <EyeIcon aria-hidden className="size-6" />
          {t("selectPrompt")}
        </div>
      </div>
    )
  }

  const percent =
    state.status === "loading" && file.size > 0 ? Math.floor((state.done / file.size) * 100) : 0

  return (
    <div className={frame} aria-label={t("previewRegion")} role="region">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <FileGlyph file={file} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{file.name}</p>
          <p className="truncate text-xs text-muted-foreground" title={file.path}>
            {file.path} · {formatBytes(file.size)}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => onDownload(file)}
          disabled={state.status === "loading"}
        >
          <DownloadIcon aria-hidden className="size-4" />
          {t("downloadButton")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {state.status === "error" ? (
          <Centered>
            <p className="text-destructive">{t(`error.${state.error}`)}</p>
          </Centered>
        ) : kind === null ? (
          <Centered>
            <FileGlyph file={file} size="lg" />
            <p>{t("noPreview")}</p>
          </Centered>
        ) : state.status === "ready" ? (
          <FilePreview kind={kind} blob={state.blob} name={file.name} />
        ) : state.status === "loading" || autoLoad ? (
          <Centered>
            <Loader2Icon aria-hidden className="size-5 animate-spin" />
            <p>{t("loadingPreview")}</p>
            {state.status === "loading" && percent > 0 ? (
              <p className="tabular-nums">{t("progress", { percent })}</p>
            ) : null}
          </Centered>
        ) : (
          <Centered>
            <Button type="button" variant="outline" size="sm" onClick={() => onLoad(file)}>
              <EyeIcon aria-hidden className="size-4" />
              {t("showPreview", { size: formatBytes(file.size) })}
            </Button>
          </Centered>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function FilePreview({ kind, blob, name }: { kind: PreviewKind; blob: Blob; name: string }) {
  const t = useTranslations("share.view.files")
  const url = useMemo(() => {
    if (kind === "text") return null
    const type = kind === "pdf" ? "application/pdf" : blob.type
    return URL.createObjectURL(new Blob([blob], { type }))
  }, [kind, blob])
  const [text, setText] = useState<{ blob: Blob; value: string } | null>(null)

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  useEffect(() => {
    if (kind !== "text") return
    let active = true
    void blob.text().then((value) => {
      if (active) setText({ blob, value })
    })
    return () => {
      active = false
    }
  }, [kind, blob])

  if (kind === "image" && url) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- a decrypted blob: URL, not a static asset */}
        <img
          src={url}
          alt={name}
          className="max-h-[70vh] max-w-full rounded-md object-contain shadow-sm"
        />
      </div>
    )
  }
  if (kind === "pdf" && url) {
    return (
      <object
        data={url}
        type="application/pdf"
        aria-label={t("previewTitle", { name })}
        className="h-[75vh] w-full flex-1"
      >
        <Centered>{t("pdfFallback")}</Centered>
      </object>
    )
  }
  const value = text?.blob === blob ? text.value : null
  return value === null ? (
    <Centered>
      <Loader2Icon aria-hidden className="size-5 animate-spin" />
      <p>{t("loadingPreview")}</p>
    </Centered>
  ) : (
    <pre className="max-h-[70vh] flex-1 overflow-auto bg-muted/30 p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
      {value}
    </pre>
  )
}
