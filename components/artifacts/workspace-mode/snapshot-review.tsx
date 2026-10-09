"use client"

/**
 * SnapshotReview: the dock review for a diff that is not the working tree:
 * one chat turn, one commit, or this branch against a base.
 *
 * Read-only by construction. There is nothing to stage or discard in a commit
 * or in a turn that already happened, so this is a file list and the diff
 * viewer, without the stage/discard actions `WorkspaceReview` gives the working
 * tree. Listing is one call (`listReviewScopeFiles`); a file's diff is read when
 * it is opened (`loadReviewScopeDiff`).
 *
 * Layout follows `WorkspaceReview`: side by side when wide, one pane at a time
 * when stacked, with Back and previous / next file in the diff toolbar.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { DiffViewer } from "@/components/source-control/diff-viewer"
import { splitPath, statusDecoration } from "@/components/source-control/status-decoration"
import { useResizableLayout } from "@/hooks/ui/use-resizable-layout"
import {
  listReviewScopeFiles,
  loadReviewScopeDiff,
  refsForSelection,
  type ReviewScopeFileRef,
  type ReviewScopeRequest,
  type UnavailableReviewRoot,
} from "@/lib/review/scope"
import { cn } from "@/lib/utils"
import type { GitDiff } from "@/types/git"
import type { ReviewScopeSelection } from "@/types/review"

export type SnapshotSelection = Extract<
  ReviewScopeSelection,
  { scope: "lastTurn" | "commit" | "branch" }
>

export function isSnapshotSelection(
  selection: ReviewScopeSelection | { scope: "conversation" }
): selection is SnapshotSelection {
  return (
    selection.scope === "lastTurn" || selection.scope === "commit" || selection.scope === "branch"
  )
}

export interface SnapshotReviewProps {
  rootPath: string
  selection: SnapshotSelection
  /** Open on this file when it is in the list (a reveal that named one). */
  focusPath?: string | null
  stacked: boolean
  touch: boolean
  /** The scope bar, drawn above the list. */
  header: ReactNode
}

type Listing =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; files: ReviewScopeFileRef[]; unavailable: UnavailableReviewRoot[] }

/** A read diff. A selected file with no entry for its path is still loading. */
type DiffState =
  | { path: string; state: "error"; message: string }
  | { path: string; state: "ready"; diff: GitDiff }

function selectionKey(rootPath: string, selection: SnapshotSelection): string {
  return JSON.stringify([rootPath, selection])
}

export function SnapshotReview({
  rootPath,
  selection,
  focusPath = null,
  stacked,
  touch,
  header,
}: SnapshotReviewProps) {
  const t = useTranslations("artifacts.workspace")
  const splitLayout = useResizableLayout("cognia-dock-review-split")
  const key = selectionKey(rootPath, selection)
  const request = useMemo<ReviewScopeRequest>(
    () => ({
      scope: selection.scope,
      repositoryRoots: [rootPath],
      defaults: refsForSelection(selection),
    }),
    // `key` is the value identity of (rootPath, selection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  )

  const [listing, setListing] = useState<{ key: string; value: Listing }>({
    key,
    value: { state: "loading" },
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [pane, setPane] = useState<"list" | "detail">(focusPath ? "detail" : "list")
  const [diff, setDiff] = useState<DiffState | null>(null)

  useEffect(() => {
    let cancelled = false
    listReviewScopeFiles(request)
      .then(({ files, unavailable }) => {
        if (cancelled) return
        setListing({ key, value: { state: "ready", files, unavailable } })
        const focused = focusPath ? files.find((file) => file.path === focusPath) : undefined
        setSelected(focused?.path ?? (stacked ? null : (files[0]?.path ?? null)))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setListing({
          key,
          value: {
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
    return () => {
      cancelled = true
    }
    // A focus or layout change alone must not re-list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, key])

  const current: Listing = useMemo(
    () => (listing.key === key ? listing.value : { state: "loading" }),
    [listing, key]
  )
  const files = useMemo(() => (current.state === "ready" ? current.files : []), [current])
  const selectedRef = files.find((file) => file.path === selected) ?? null

  useEffect(() => {
    if (!selectedRef) return
    let cancelled = false
    loadReviewScopeDiff(request, selectedRef)
      .then((next) => {
        if (!cancelled) setDiff({ path: selectedRef.path, state: "ready", diff: next })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDiff({
            path: selectedRef.path,
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [request, selectedRef])

  const index = selectedRef ? files.indexOf(selectedRef) : -1
  const prev = index > 0 ? files[index - 1] : null
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : null
  const open = useCallback((path: string) => {
    setSelected(path)
    setPane("detail")
  }, [])

  const navButton = cn("text-muted-foreground", touch ? "size-11" : "size-7")
  const leading = (
    <>
      {stacked ? (
        <Button
          type="button"
          variant="ghost"
          size={touch ? "sm" : "xs"}
          className={cn("shrink-0 gap-1 px-1.5", touch && "min-h-11 px-2")}
          onClick={() => setPane("list")}
          aria-label={t("reviewBack")}
          title={t("reviewBack")}
          data-testid="snapshot-review-back"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      ) : null}
      <div role="group" aria-label={t("reviewFileNav")} className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={navButton}
          disabled={!prev}
          onClick={() => prev && open(prev.path)}
          aria-label={t("reviewPrevFile")}
          title={t("reviewPrevFile")}
          data-testid="snapshot-review-prev-file"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        {index >= 0 ? (
          <span
            className="min-w-[3.5ch] text-center font-mono text-[11px] text-muted-foreground tabular-nums"
            aria-label={t("reviewFilePositionLabel", { index: index + 1, total: files.length })}
          >
            {t("reviewFilePosition", { index: index + 1, total: files.length })}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={navButton}
          disabled={!next}
          onClick={() => next && open(next.path)}
          aria-label={t("reviewNextFile")}
          title={t("reviewNextFile")}
          data-testid="snapshot-review-next-file"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
    </>
  )

  const message = (text: string, testId: string) => (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground"
      data-testid={testId}
    >
      {text}
    </div>
  )

  const listBody =
    current.state === "loading" ? (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground"
        data-testid="snapshot-review-loading"
      >
        <Spinner className="mr-2 size-4" />
        {t("snapshot.loading")}
      </div>
    ) : current.state === "error" ? (
      message(t("snapshot.listFailed", { error: current.message }), "snapshot-review-error")
    ) : current.unavailable.length > 0 ? (
      message(
        t(`snapshot.unavailable.${current.unavailable[0].reason}`),
        "snapshot-review-unavailable"
      )
    ) : files.length === 0 ? (
      message(t("snapshot.empty"), "snapshot-review-empty")
    ) : (
      <ul className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="snapshot-review-files">
        {files.map((file) => {
          const deco = file.status ? statusDecoration(file.status) : null
          const { dir, name } = splitPath(file.path)
          return (
            <li key={file.reviewKey}>
              <button
                type="button"
                onClick={() => open(file.path)}
                aria-current={file.path === selected ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2 text-left text-xs hover:bg-accent",
                  touch ? "min-h-11 py-1" : "h-7",
                  file.path === selected && "bg-accent"
                )}
                data-testid={`snapshot-review-file-${file.path}`}
              >
                <FileTypeIcon path={file.path} />
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  <span className="text-foreground">{name}</span>
                  {dir ? (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">{dir}</span>
                  ) : null}
                </span>
                {deco ? (
                  <span className={cn("w-3 shrink-0 text-center font-mono", deco.colorClass)}>
                    {deco.letter}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    )

  const list = (
    <div className="flex h-full min-h-0 flex-col" data-testid="snapshot-review-list">
      {header}
      {listBody}
    </div>
  )

  const currentDiff = diff && selectedRef && diff.path === selectedRef.path ? diff : null
  const detail = !selectedRef ? (
    message(t("reviewEmpty"), "snapshot-review-no-selection")
  ) : currentDiff?.state === "error" ? (
    message(t("snapshot.diffFailed", { error: currentDiff.message }), "snapshot-review-diff-error")
  ) : (
    <DiffViewer
      diff={currentDiff?.state === "ready" ? currentDiff.diff : null}
      staged={false}
      readOnly
      density={touch ? "touch" : "compact"}
      toolbarStart={leading}
    />
  )

  return (
    <div
      className="h-full min-h-0 min-w-0"
      data-testid="snapshot-review"
      data-scope={selection.scope}
      data-layout={stacked ? "stacked" : "split"}
    >
      {stacked ? (
        pane === "detail" && selectedRef ? (
          <div className="h-full min-h-0">{detail}</div>
        ) : (
          list
        )
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={splitLayout.onLayoutChanged}
        >
          <ResizablePanel id="workspace-review-changes" defaultSize="34%" minSize="22%">
            {list}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="workspace-review-diff" defaultSize="66%" minSize="40%">
            {detail}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}
