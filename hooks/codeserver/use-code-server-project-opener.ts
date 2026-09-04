"use client"

/**
 * Register a running code-server as the project-editor opener for `root`.
 *
 * Every verb below is `target: "execution"` in the companion command catalogue,
 * so `RoutingTransport` carries it to whichever host owns the workbench. That
 * is what makes this hook shell-agnostic, and why the native desktop pane and
 * the browser one can share it instead of keeping two copies of a registration
 * that has to stay in step with `ProjectEditorOpener`.
 *
 * Registration is gated on the workbench actually being able to service a call.
 * Registering earlier guarantees a raw "code-server is not running" toast for
 * any jump that lands mid-download. The bridge holds a deferred request instead
 * and replays it the moment this registers.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { codeServerClient } from "@/lib/codeserver/client"
import { createCodeServerOpenQueue } from "@/lib/codeserver/open-file-queue"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"

/** Join a project root with a project-relative path into an absolute path. */
export function joinProjectPath(root: string, relative: string): string {
  const base = root.replace(/[/\\]+$/, "")
  const clean = relative.replace(/^[/\\]+/, "")
  return clean ? `${base}/${clean}` : base
}

export interface UseCodeServerProjectOpenerOptions {
  /** Project root the workbench is serving. */
  root: string
  /** Only register once the workbench can answer. */
  enabled: boolean
  /** Make the host's file surface visible before a bridge capability uses it. */
  beforeOpen?: () => void
}

export function useCodeServerProjectOpener({
  root,
  enabled,
  beforeOpen,
}: UseCodeServerProjectOpenerOptions): void {
  const t = useTranslations("projectEditor")

  useEffect(() => {
    if (!enabled) return
    const onError = (cause: unknown) =>
      toast.error(t("proIde.openFileFailed", { error: String(cause) }))
    // Prefer the companion extension: it opens in the live window with no CLI
    // cold start. Fall back to the CLI reuse-window path when the extension is
    // not connected (still installing, or an older code-server).
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
    // Agent writes reflect as an undo-able edit, degrading to a reveal (then
    // the CLI) when the extension cannot apply it.
    const editQueue = createCodeServerOpenQueue(
      async (path, line, column) => {
        try {
          await codeServerClient.driveApplyEdit(root, joinProjectPath(root, path), line, column)
        } catch (cause) {
          // A dirty editor buffer contains user-authored work that is not on
          // disk. Revealing or falling back would hide the failed
          // reconciliation, so surface the conflict and make the user resolve it.
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
      open: (path, line, column) => {
        beforeOpen?.()
        openQueue.request(path, line, column)
      },
      applyEdit: (path, line, column) => {
        beforeOpen?.()
        editQueue.request(path, line, column)
      },
      // Registered only once enabled, like the openers above: before that the
      // companion extension is not connected and a read would reject rather
      // than fall through to whichever editor IS live.
      readActive: () => codeServerClient.readActive(root),
      // Dirty VS Code buffers are invisible to the agent's disk-based file
      // tools, and flushing them is what stops a turn reading stale content and
      // then overwriting the user's unsaved work.
      saveDirty: async () => (await codeServerClient.saveAll(root)).failed,
      showDiff: (path, content, title) => {
        beforeOpen?.()
        return codeServerClient.showDiff(root, joinProjectPath(root, path), content, title)
      },
      reveal: (path) => {
        beforeOpen?.()
        return codeServerClient.reveal(root, joinProjectPath(root, path))
      },
      runInTerminal: (command, options) => {
        beforeOpen?.()
        return codeServerClient.runInTerminal(root, command, {
          cwd: options?.cwd ?? root,
          ...options,
        })
      },
      notify: (message, kind) => codeServerClient.notify(root, message, kind),
    })
    return () => {
      unregister()
      openQueue.dispose()
      editQueue.dispose()
    }
  }, [beforeOpen, enabled, root, t])
}
