"use client"

// The optional "Pro IDE" surface for the project editors: a native code-server
// (browser VS Code) webview pinned over this pane, downloaded on first use.
// Desktop-only; augments — never replaces — the Monaco editor. The webview
// itself is a single shared resource owned by `lib/codeserver/pane-manager`.

import { useCallback, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorXIcon, RotateCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useCodeServerPane } from "@/hooks/codeserver/use-code-server-pane"
import { useCodeServerThemeSync } from "@/hooks/codeserver/use-code-server-theme-sync"
import { codeServerClient } from "@/lib/codeserver/client"
import { createCodeServerOpenQueue } from "@/lib/codeserver/open-file-queue"
import { PRO_IDE_REGION_ATTR } from "@/lib/codeserver/pane-manager"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"

interface Props {
  /** Project root code-server should open (the selected worktree root). */
  root: string
  /** Stable id for this surface in the shared-pane ownership handoff. */
  ownerId: string
  /** Called when another surface claims the shared pane away from this one. */
  onRevoked: () => void
  /**
   * Called when the user cancels the first-run download. The host is expected
   * to switch its engine back to Monaco — there is nothing to show here
   * otherwise, and leaving the user staring at a dead pane is what made the
   * uncancellable download feel like a trap in the first place.
   */
  onCancelled?: () => void
}

/** Join a project root with a project-relative path into an absolute path. */
export function joinProjectPath(root: string, relative: string): string {
  const base = root.replace(/[/\\]+$/, "")
  const clean = relative.replace(/^[/\\]+/, "")
  return clean ? `${base}/${clean}` : base
}

export function CodeServerPane({ root, ownerId, onRevoked, onCancelled }: Props) {
  const t = useTranslations("projectEditor")
  const ref = useRef<HTMLDivElement>(null)
  // A1: the single native pane is shared with the Agent Team editor tab; claiming
  // it there (or an explicit Pro IDE stop) revokes this one, and the host falls
  // back to Monaco. That used to be silent — surface it so losing the VS Code view
  // isn't a mystery.
  const handleRevoked = useCallback(() => {
    toast.info(t("proIde.revokedToMonaco"))
    onRevoked()
  }, [onRevoked, t])
  const { phase, mounted, progress, error, retry } = useCodeServerPane(ref, {
    root,
    ownerId,
    onRevoked: handleRevoked,
  })
  const percent = progress != null ? Math.round(progress * 100) : null

  const cancelDownload = useCallback(() => {
    // Fire-and-forget: the backend drops the streaming future and deletes the
    // partial archive, and the in-flight `ensure` rejects on its own. Swallow
    // the result so a cancel can never itself raise at the user.
    void codeServerClient.cancelDownload().catch(() => {})
    onCancelled?.()
  }, [onCancelled])
  // Paint code-server in the app palette. Kept outside the phase gate so the
  // very first spawn already reads a themed settings.json.
  useCodeServerThemeSync(true)
  // `ready` only means code-server answers; the native webview lands a beat
  // later. Holding the placeholder until it is actually mounted removes the
  // flash of bare background in between.
  const showPlaceholder = phase !== "ready" || !mounted

  // Register as the project-editor opener only once code-server can actually
  // service an open. Registering earlier guarantees a raw "code-server is not
  // running" toast for any jump that lands mid-download; the bridge holds a
  // deferred request instead and replays it when we register.
  useEffect(() => {
    if (phase !== "ready") return
    const onError = (cause: unknown) =>
      toast.error(t("proIde.openFileFailed", { error: String(cause) }))
    // Prefer the companion extension: it opens in the live window with no CLI
    // cold start. Fall back to the CLI reuse-window path when the extension isn't
    // connected (still installing, or an older code-server).
    const openQueue = createCodeServerOpenQueue(
      async (path, line, column) => {
        try {
          await codeServerClient.driveOpen(root, joinProjectPath(root, path), line, column)
        } catch {
          await codeServerClient.openFile(root, path, line, column)
        }
      },
      { onError }
    )
    // Agent writes reflect as an undo-able edit; degrade to a reveal (then the CLI)
    // when the extension can't apply it.
    const editQueue = createCodeServerOpenQueue(
      async (path, line, column) => {
        try {
          await codeServerClient.driveApplyEdit(root, joinProjectPath(root, path), line, column)
        } catch (cause) {
          // A dirty editor buffer contains user-authored work that is not on
          // disk. Revealing/falling back would hide the failed reconciliation,
          // so surface the conflict and require the user to resolve it.
          if (String(cause).includes("DIRTY_DOCUMENT_CONFLICT")) throw cause
          try {
            await codeServerClient.driveOpen(root, joinProjectPath(root, path), line, column)
          } catch {
            await codeServerClient.openFile(root, path, line, column)
          }
        }
      },
      { onError }
    )
    const unregister = registerProjectEditorOpener({
      root,
      open: (path, line, column) => openQueue.request(path, line, column),
      applyEdit: (path, line, column) => editQueue.request(path, line, column),
      // Registered only from `ready`, like the openers above: before that the
      // companion extension isn't connected and a read would reject rather than
      // fall through to whichever editor *is* live.
      readActive: () => codeServerClient.readActive(root),
    })
    return () => {
      unregister()
      openQueue.dispose()
      editQueue.dispose()
    }
  }, [phase, root, t])

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="code-server-pane">
      {/* Reserved region the native code-server webview is positioned over. The
          marker lets an animating ancestor detect that it is about to tween a
          box containing an unclippable native layer — see
          `isProIdePanePinnedWithin`. */}
      <div
        ref={ref}
        className="absolute inset-0"
        data-testid="code-server-region"
        {...{ [PRO_IDE_REGION_ATTR]: "" }}
      />

      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-background p-6 text-center">
          {phase === "unsupported" ? (
            <div
              className="flex max-w-sm flex-col items-center gap-2"
              data-testid="code-server-unsupported"
            >
              <MonitorXIcon className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t("proIde.unsupportedTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("proIde.unsupportedDesc")}</p>
            </div>
          ) : phase === "error" ? (
            <div
              className="flex max-w-sm flex-col items-center gap-3"
              data-testid="code-server-error"
            >
              <p className="text-sm font-medium">{t("proIde.errorTitle")}</p>
              {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
              <Button size="sm" variant="outline" onClick={retry}>
                <RotateCwIcon className="size-3.5" />
                {t("proIde.retry")}
              </Button>
            </div>
          ) : (
            <div
              className="flex w-full max-w-xs flex-col items-center gap-2 text-sm text-muted-foreground"
              data-testid="code-server-loading"
            >
              <Loader2Icon className="size-5 animate-spin" />
              <span>
                {phase === "downloading" && percent != null
                  ? t("proIde.downloading", { percent })
                  : t("proIde.starting")}
              </span>
              {/* The first run pulls ~100-200MB; a bare percentage is a weak
                  affordance for a wait that long. */}
              {phase === "downloading" && percent != null ? (
                <Progress value={percent} className="h-1.5" data-testid="code-server-progress" />
              ) : null}
              {/* …and a wait that long with no way out is a trap: a mis-click
                  on the engine toggle used to commit the user to the whole
                  transfer. Offered for the whole pre-ready window, not just
                  `downloading`, since "starting" can also sit a while. */}
              {onCancelled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={cancelDownload}
                  data-testid="code-server-cancel"
                >
                  {t("proIde.cancelDownload")}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
