"use client"

import { KeyRoundIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { localBrowser } from "@/lib/browser/local-client"
import { getPendingSave, resolvePendingSave, type PendingSaveInfo } from "@/lib/browser/passwords"

type SaveAction = "save" | "update" | "never" | "dismiss"

export type PendingCredentialSave = {
  pendingId: string
  sessionId: string
  origin: string
  username: string
  /**
   * Rust's classification against the vault: `update` when a credential with
   * this username is saved for the site under a different password.
   */
  mode: "save" | "update"
}

/**
 * What to do with one classified submission: prompt (`save` / `update`),
 * resolve it silently with `dismiss` so Rust drops the stash (`unchanged`:
 * nothing to ask; `suppressed`: the user chose "never" for the site), or skip
 * it (`null`: the pending id expired).
 */
export function pendingSaveDecision(
  info: PendingSaveInfo | null
): { kind: "prompt"; mode: "save" | "update" } | { kind: "dismiss" } | { kind: "skip" } {
  if (!info) return { kind: "skip" }
  if (info.kind === "save" || info.kind === "update") return { kind: "prompt", mode: info.kind }
  return { kind: "dismiss" }
}

type SubmittedEvent = { sessionId: string; origin: string; username: string; pendingId: string }

/**
 * Narrow a `browser-local://event` payload to `credential.submitted`. Rust has
 * already stashed the password and forwards only `{origin, username,
 * pendingId}` — the value itself never reaches the renderer.
 */
export function asCredentialSubmitted(event: unknown): SubmittedEvent | null {
  if (!event || typeof event !== "object") return null
  const record = event as Record<string, unknown>
  if (record.type !== "credential.submitted") return null
  const { sessionId, origin, username, pendingId } = record
  if (
    typeof sessionId !== "string" ||
    typeof origin !== "string" ||
    typeof username !== "string" ||
    typeof pendingId !== "string" ||
    !pendingId
  ) {
    return null
  }
  return { sessionId, origin, username, pendingId }
}

/**
 * Save / update prompt after a sign-in form is submitted in local Chromium
 * (ADR-0201). Each submission waits in Rust under a pending id, which Rust
 * classifies against the vault (`getPendingSave`): only a new login or a
 * changed password prompts; an unchanged or "never"-listed one is dismissed
 * silently and an expired one skipped. The user's choice resolves it (`save`, `update`, `never` for the site, or `dismiss`).
 * Prompts still queued when the surface unmounts are dismissed so Rust drops
 * the stashed values.
 */
export function BrowserSavePasswordPrompt({
  sessionId,
}: {
  /** Only prompt for submissions from this local session; all sessions when omitted. */
  sessionId?: string
}) {
  const t = useTranslations("browserVault.savePrompt")
  const [queue, setQueue] = useState<PendingCredentialSave[]>([])
  const [busy, setBusy] = useState(false)
  const queueRef = useRef<PendingCredentialSave[]>([])

  // The ref mirrors the queue so unmount can dismiss whatever is still waiting.
  // Both are only written from event handlers, never during render.
  const replaceQueue = (next: PendingCredentialSave[]) => {
    queueRef.current = next
    setQueue(next)
  }

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void localBrowser
      .onEvent((event: unknown) => {
        const submitted = asCredentialSubmitted(event)
        if (!submitted || (sessionId && submitted.sessionId !== sessionId)) return
        void getPendingSave(submitted.pendingId)
          .then(pendingSaveDecision)
          // Classification failed (vault unreadable): still offer to save, as
          // the user just signed in; resolving reports its own failure.
          .catch(() => ({ kind: "prompt", mode: "save" }) as const)
          .then((decision) => {
            if (decision.kind === "skip") return
            if (disposed || decision.kind === "dismiss") {
              void resolvePendingSave(submitted.pendingId, "dismiss").catch(() => undefined)
              return
            }
            const pending = queueRef.current
            if (pending.some((item) => item.pendingId === submitted.pendingId)) return
            queueRef.current = [...pending, { ...submitted, mode: decision.mode }]
            setQueue(queueRef.current)
          })
      })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
    return () => {
      disposed = true
      unlisten?.()
      for (const pending of queueRef.current) {
        void resolvePendingSave(pending.pendingId, "dismiss").catch(() => undefined)
      }
      queueRef.current = []
    }
  }, [sessionId])

  const current = queue[0]
  if (!current) return null

  const resolve = async (action: SaveAction) => {
    if (busy) return
    setBusy(true)
    try {
      await resolvePendingSave(current.pendingId, action)
      if (action === "save") toast.success(t("saved"))
      if (action === "update") toast.success(t("updated"))
      replaceQueue(queueRef.current.filter((item) => item.pendingId !== current.pendingId))
    } catch {
      toast.error(t("failed"))
    } finally {
      setBusy(false)
    }
  }

  const values = { username: current.username, origin: current.origin }
  return (
    <div
      role="region"
      aria-label={t("region")}
      className="grid gap-2 rounded-md border bg-popover p-3 text-sm shadow-md"
    >
      <div className="flex items-start gap-2">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-medium">
            {current.mode === "update" ? t("updateTitle") : t("saveTitle")}
          </p>
          <p className="text-muted-foreground break-words">
            {current.mode === "update"
              ? t("updateDescription", values)
              : t("saveDescription", values)}
          </p>
          {queue.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {t("more", { count: queue.length - 1 })}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve("never")}>
          {t("never")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve("dismiss")}>
          {t("dismiss")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void resolve(current.mode)}>
          {current.mode === "update" ? t("update") : t("save")}
        </Button>
      </div>
    </div>
  )
}
