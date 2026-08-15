"use client"

import { useEffect, useState, type ComponentType } from "react"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"
import { Button } from "@/components/ui/button"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { readWorkspaceFile, statWorkspaceFile } from "@/lib/files/workspace-fs"
import { BUILTIN_TEXT_VIEWER_ID } from "@/lib/file-viewer/builtins"
import {
  MAX_VIEWER_BYTES,
  exceedsUtf8Limit,
  extensionOf,
  sizeBucket,
  utf8ByteLength,
} from "@/lib/file-viewer/probe"
import { getFileViewer, resolveFileViewer } from "@/lib/file-viewer/registry"
import {
  fileViewerErrorMessageKey,
  type FileViewerContribution,
  type FileViewerErrorCode,
  type FileViewerRenderProps,
  type FileViewerRequest,
} from "@/lib/file-viewer/types"

/**
 * `dynamic()` must not run during render — a fresh component identity every
 * frame would remount the viewer, and with it a Monaco instance. Cached by
 * contribution id at module scope so each viewer is wrapped exactly once.
 */
const lazyViewers = new Map<string, ComponentType<FileViewerRenderProps>>()

function lazyViewer(contribution: FileViewerContribution): ComponentType<FileViewerRenderProps> {
  const cached = lazyViewers.get(contribution.id)
  if (cached) return cached
  // `ssr: false` is required rather than tidy: Monaco cannot prerender, and a
  // static export prerenders client components at build time.
  const loaded = dynamic(contribution.load, { ssr: false })
  lazyViewers.set(contribution.id, loaded)
  return loaded
}

/** Maps a rejected transport call onto the taxonomy the surface renders. */
function classifyReadError(error: unknown): FileViewerErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  // The Rust side canonicalises both the root and the target and rejects an
  // escape with this phrase; anything else is an ordinary IO failure.
  return message.includes("escapes workspace") ? "outside-workspace" : "read-failed"
}

type LoadState =
  | { requestId: string; phase: "ready"; text: string }
  | { requestId: string; phase: "error"; code: FileViewerErrorCode }

/**
 * The one place a file becomes text on screen.
 *
 * Both entry points — the project workbench's preview panel and the read-only
 * dialog behind terminal and chat file links — are thin wrappers over this.
 * They differ only in how the request is built: the workbench hands over the
 * live editor draft, so it never touches the disk at all.
 */
export function FilePreviewSurface({ request }: { request: FileViewerRequest | null }) {
  const t = useTranslations("fileViewer")
  const [state, setState] = useState<LoadState | null>(null)
  // Scoped to a request so the affordance cannot leak across files; a plain
  // boolean would survive into the next open.
  const [forced, setForced] = useState<{ requestId: string; viewerId: string } | null>(null)

  useEffect(() => {
    if (!request) return
    let cancelled = false
    const startedAt = Date.now()
    const settle = (next: LoadState) => {
      // The request may have moved on while this read was in flight. Dropping
      // the stale result is what stops a slow open for one file painting over
      // a fast open for another.
      if (!cancelled) setState(next)
    }

    const load = async (): Promise<LoadState> => {
      const id = request.requestId
      // Host-supplied text short-circuits *before* the backend probe, so the
      // workbench preview never reaches the filesystem at all.
      if (request.providedText !== undefined) {
        return exceedsUtf8Limit(request.providedText)
          ? { requestId: id, phase: "error", code: "too-large" }
          : { requestId: id, phase: "ready", text: request.providedText }
      }
      if (!request.root) return { requestId: id, phase: "error", code: "no-root" }
      if (!hasWorkspaceFsBackend()) {
        return { requestId: id, phase: "error", code: "no-backend" }
      }
      try {
        const stat = await statWorkspaceFile(request.root, request.relPath)
        if (!stat.exists) return { requestId: id, phase: "error", code: "not-found" }
        if (stat.isDir) return { requestId: id, phase: "error", code: "is-directory" }
        // Refuse before reading, so an oversized file costs one stat rather
        // than a multi-megabyte transfer.
        if (stat.size > MAX_VIEWER_BYTES) {
          return { requestId: id, phase: "error", code: "too-large" }
        }
        // `MAX + 1`: the Rust side truncates only above the limit it is given
        // and appends a marker when it does, so asking for one byte more turns
        // a file that grew between the stat and the read into a detectable
        // overflow instead of a silently shortened document.
        const text = await readWorkspaceFile(request.root, request.relPath, MAX_VIEWER_BYTES + 1)
        if (exceedsUtf8Limit(text)) {
          return { requestId: id, phase: "error", code: "too-large" }
        }
        return { requestId: id, phase: "ready", text }
      } catch (error) {
        return { requestId: id, phase: "error", code: classifyReadError(error) }
      }
    }

    void load().then((next) => {
      settle(next)
      if (cancelled) return
      const bytes = next.phase === "ready" ? utf8ByteLength(next.text) : 0
      const base = {
        source: request.source,
        extension: extensionOf(request.relPath),
        sizeBucket: sizeBucket(bytes),
        durationMs: Date.now() - startedAt,
      }
      // Never a path, a filename or any content: an extension is safe to record,
      // a name is not, and a byte count is a weak content fingerprint.
      if (next.phase === "error")
        loggers.files.warn("fileViewer.error", { ...base, code: next.code })
      else loggers.files.debug("fileViewer.render", base)
    })

    return () => {
      cancelled = true
    }
  }, [request])

  if (!request) return null

  // Derived rather than reset in an effect: a stale entry simply is not this
  // request's, which reads as loading without a second state write.
  const current = state?.requestId === request.requestId ? state : null
  const forcedViewerId = forced?.requestId === request.requestId ? forced.viewerId : null

  if (!current) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="file-preview-loading">
        {t("loading")}
      </p>
    )
  }

  if (current.phase === "error") {
    return (
      <p
        className="p-4 text-sm text-destructive"
        data-testid="file-preview-error"
        data-error-code={current.code}
      >
        {t(fileViewerErrorMessageKey(current.code), {
          limit: `${MAX_VIEWER_BYTES / (1024 * 1024)} MB`,
        })}
      </p>
    )
  }

  const probe = {
    extension: extensionOf(request.relPath),
    size: utf8ByteLength(current.text),
    source: request.source,
  }
  const contribution = forcedViewerId ? getFileViewer(forcedViewerId) : resolveFileViewer(probe)

  if (!contribution) {
    return (
      <p
        className="p-4 text-sm text-muted-foreground"
        data-testid="file-preview-error"
        data-error-code="unsupported"
      >
        {t("error.unsupported")}
      </p>
    )
  }

  const Viewer = lazyViewer(contribution)
  // Only the text viewer can honour a location, so rather than dropping the
  // line silently the surface offers a way to reach it — reusing the text
  // already in hand, with no second read and no new request.
  const offerLine =
    request.line != null &&
    contribution.id !== BUILTIN_TEXT_VIEWER_ID &&
    request.source === "terminal"

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="file-preview-surface"
      data-source={request.source}
      data-viewer-id={contribution.id}
    >
      {offerLine ? (
        <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="file-preview-open-at-line"
            onClick={() =>
              setForced({ requestId: request.requestId, viewerId: BUILTIN_TEXT_VIEWER_ID })
            }
          >
            {t("openAtLine", { line: request.line ?? 0 })}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* The rule guards against a *fresh* component identity each render,
            which would remount the viewer — and any Monaco inside it — every
            frame. `lazyViewer` memoises by contribution id at module scope, so
            the identity here is stable for the life of the process: the
            condition the rule enforces, reached through a cache it cannot see. */}
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Viewer
          text={current.text}
          displayName={request.displayName}
          relPath={request.relPath}
          line={request.line ?? null}
          column={request.column ?? null}
          source={request.source}
        />
      </div>
    </div>
  )
}

export default FilePreviewSurface
