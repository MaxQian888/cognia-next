"use client"

import { useEffect, useMemo, useState } from "react"
import { FileDiffIcon, ShapesIcon, type LucideIcon } from "lucide-react"
import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { useTranslations } from "next-intl"
import { ArtifactList } from "@/components/artifacts/artifact-list"
import { ExternalLink } from "@/components/shared/external-link"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { findUrlSpans } from "@/lib/chat/link-token"
import { FilePartPreview } from "@/components/chat/message-parts/file-part-preview"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { SESSION_ARTIFACT_LIST_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  installTaskWorkspaceEventListener,
  listTaskResources,
  listTaskWorkspaces,
} from "@/lib/task-workspace/client"
import type { ResourceChange } from "@/lib/task-workspace/types"

export interface SessionResultsSectionProps {
  session: ChatSession
  messages: readonly UIMessage[]
  onNavigate: (panelId: string) => void
  compact?: boolean
}

/**
 * One clickable count in the compact card's result grid.
 *
 * The rows this replaces were `<Button variant="ghost">`s rendering bare text
 * ("2 artifacts") at `px-0`, so nothing about them read as a control and the
 * count — the only number on the card — was set in the same 12px as every
 * label around it. The tile keeps the hue in the wash, the border and the icon
 * and leaves the number on `--foreground`, which is the one part that has to
 * stay legible in both themes.
 */
function ResultTile({
  icon: Icon,
  count,
  label,
  tone,
  onClick,
}: {
  icon: LucideIcon
  count: number
  label: string
  tone: "artifacts" | "files"
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/tile flex min-w-0 flex-col items-start gap-0.5 rounded-lg border px-2 py-1.5 text-left",
        "transition-[background-color,border-color,transform] duration-[calc(160ms*var(--motion-duration-scale,1))]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97]",
        tone === "artifacts"
          ? "border-info/30 bg-info/8 hover:border-info/60 hover:bg-info/15"
          : "border-success/30 bg-success/8 hover:border-success/60 hover:bg-success/15"
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon
          className={cn("size-3.5", tone === "artifacts" ? "text-info" : "text-success")}
          aria-hidden
        />
        <span className="text-base font-medium leading-none tabular-nums">{count}</span>
      </span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{label}</span>
    </button>
  )
}

/** A summary of existing result sources; editing remains in their own panels. */
export function SessionResultsSection({
  session,
  messages,
  onNavigate,
  compact = false,
}: SessionResultsSectionProps) {
  const t = useTranslations("contextWorkbench.taskOverview.results")
  const tResources = useTranslations("artifacts.workspace.taskResources")
  const artifactCount = useArtifactStore(
    (state) =>
      Object.values(state.artifacts).filter((artifact) => artifact.sessionId === session.id).length
  )
  const workspaceAvailable = hasWorkspaceFsBackend()
  const active = useTaskWorkspaceStore((state) => state.activeBySession[session.id])
  const cached = useTaskWorkspaceStore((state) =>
    active ? state.resourcesByTask[active.taskId] : undefined
  )
  const provisional = useTaskWorkspaceStore((state) =>
    active ? state.provisionalByRun[active.runId] : undefined
  )
  const taskId = active?.taskId
  const requestKey = active
    ? `${session.id}:${active.taskId}:${active.runId}:${active.state}:${provisional?.revision ?? 0}`
    : session.id
  const [loaded, setLoaded] = useState<{
    key: string
    resources?: ResourceChange[]
    failed?: boolean
    tracked?: boolean
  } | null>(null)
  const [retry, setRetry] = useState(0)
  const [listenerFailed, setListenerFailed] = useState(false)
  useEffect(() => {
    if (!workspaceAvailable) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void installTaskWorkspaceEventListener().then(
      (stop) => {
        if (disposed) stop()
        else {
          unlisten = stop
          setListenerFailed(false)
        }
      },
      () => {
        if (!disposed) setListenerFailed(true)
      }
    )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [retry, workspaceAvailable])
  useEffect(() => {
    if (!workspaceAvailable) return
    let cancelled = false
    void listTaskWorkspaces(session.id)
      .then(async (workspaces) => {
        const ids = new Set(
          workspaces
            .filter((workspace) => workspace.sessionId === session.id)
            .map((workspace) => workspace.taskId)
        )
        if (taskId) ids.add(taskId)
        const batches = await Promise.all([...ids].map((id) => listTaskResources(id)))
        return { resources: batches.flat(), tracked: ids.size > 0 }
      })
      .then(
        ({ resources, tracked }) => {
          if (!cancelled) setLoaded({ key: requestKey, resources, tracked })
        },
        () => {
          if (!cancelled) setLoaded({ key: requestKey, failed: true })
        }
      )
    return () => {
      cancelled = true
    }
  }, [session.id, taskId, requestKey, retry, cached, workspaceAvailable])
  const current = loaded?.key === requestKey ? loaded : null
  const resources = current?.resources ?? cached
  const tracked = Boolean(active) || current?.tracked
  const outputs = useMemo(() => {
    const files = new Map<string, { url: string; filename?: string; mediaType?: string }>()
    for (const message of messages) {
      if (message.role !== "assistant") continue
      for (const part of message.parts) {
        // Citations, user attachments and arbitrary tool payload URLs are inputs,
        // not evidence that a document or pull request was produced.
        if (part.type !== "file") continue
        try {
          const url = new URL(part.url)
          if (!["https:", "http:", "blob:", "data:"].includes(url.protocol)) continue
          files.set(url.href, { url: url.href, filename: part.filename, mediaType: part.mediaType })
        } catch {
          /* Incomplete streaming file parts are not actionable yet. */
        }
      }
    }
    return [...files.values()]
  }, [messages])

  const sharedLinks = useMemo(() => {
    const links = new Set<string>()
    const outputUrls = new Set(outputs.map((output) => output.url))
    for (const message of messages) {
      if (message.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "text") continue
        for (const span of findUrlSpans(part.text)) {
          try {
            const url = new URL(span.raw)
            if (!outputUrls.has(url.href)) links.add(url.href)
          } catch {
            /* Incomplete streaming links cannot be opened yet. */
          }
        }
      }
    }
    return [...links]
  }, [messages, outputs])

  if (compact) {
    // A summary only advertises actual results. Full loading diagnostics and
    // empty states remain available through View details.
    if (!artifactCount && !resources?.length && !outputs.length && !sharedLinks.length) return null
    return (
      <section aria-label={t("title")} className="space-y-2 border-t pt-2.5">
        <h3 className="text-xs font-medium">{t("title")}</h3>
        {artifactCount > 0 || resources?.length ? (
          <div className="grid grid-cols-2 gap-1.5">
            {artifactCount > 0 && (
              <ResultTile
                icon={ShapesIcon}
                tone="artifacts"
                count={artifactCount}
                label={t("artifacts")}
                onClick={() => onNavigate(SESSION_ARTIFACT_LIST_PANEL_ID)}
              />
            )}
            {!!resources?.length && (
              <ResultTile
                icon={FileDiffIcon}
                tone="files"
                count={resources.length}
                label={t("files")}
                onClick={() => onNavigate("workspace")}
              />
            )}
          </div>
        ) : null}
        {outputs.slice(0, 3).map((output) => (
          <FilePartPreview key={output.url} {...output} />
        ))}
        {sharedLinks.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">{t("sharedLinks")}</p>
            {sharedLinks.slice(0, 3).map((url) => (
              <ExternalLink
                key={url}
                href={url}
                preferEmbedded
                className="block truncate text-xs text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
                title={url}
              >
                {url}
              </ExternalLink>
            ))}
          </div>
        )}
        {outputs.length > 3 || sharedLinks.length > 3 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            onClick={() => onNavigate("metadata")}
          >
            {t("title")}
          </Button>
        ) : null}
      </section>
    )
  }

  return (
    <section aria-label={t("title")} className="space-y-4 border-t pt-4">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("artifacts")}</h4>
        <ArtifactList key={session.id} sessionId={session.id} lockSessionScope maxHeight="280px" />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("files")}</h4>
        {!workspaceAvailable ? (
          <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
        ) : (
          <>
            {current && !current.failed && !tracked ? (
              <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
            ) : null}
            {!current && !resources ? (
              <p role="status" className="text-xs text-muted-foreground">
                {t("loading")}
              </p>
            ) : null}
            {current?.failed || listenerFailed ? (
              <div role="alert" className="text-xs">
                <p>{t("failed")}</p>
                <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                  {t("retry")}
                </Button>
              </div>
            ) : null}
            {tracked && resources?.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("emptyFiles")}</p>
            ) : null}
            {resources && resources.length > 0 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t("fileCount", { count: resources.length })}
                </p>
                <ul className="space-y-1">
                  {resources.slice(0, 5).map((resource) => (
                    <li
                      key={`${resource.runId}:${resource.path}`}
                      className="flex min-w-0 items-center gap-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate" title={resource.path}>
                        {resource.path}
                      </span>
                      <Badge variant="outline">{tResources(resource.kind)}</Badge>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {tracked ? (
              <Button variant="outline" size="sm" onClick={() => onNavigate("workspace")}>
                {t("openWorkspace")}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {outputs.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("outputs")}</h4>
          <ul className="space-y-1">
            {outputs.map((output) => (
              <li key={output.url} className="min-w-0">
                <FilePartPreview
                  url={output.url}
                  filename={output.filename}
                  mediaType={output.mediaType}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {sharedLinks.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("sharedLinks")}</h4>
          <p className="text-xs text-muted-foreground">{t("sharedLinksDescription")}</p>
          <ul className="space-y-1">
            {sharedLinks.map((url) => (
              <li key={url} className="min-w-0">
                <ExternalLink
                  href={url}
                  preferEmbedded
                  className="block truncate text-xs text-primary underline"
                  title={url}
                >
                  {url}
                </ExternalLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
