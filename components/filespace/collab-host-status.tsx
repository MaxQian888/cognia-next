"use client"

/**
 * Whether this conversation's members are being served (ADR-0222 §6), in the
 * Files panel's live-sharing section of a shared conversation.
 *
 * Sharing with members registers the host that holds the files as the
 * conversation's file host; from then on the host answers members' requests
 * and mirrors its members shares to the collaboration server on its own. This
 * block is the owner's view of that: which host serves them, whether it is
 * answering, shares that have not reached the server yet, the last problem,
 * and the one way to end it. Ending it unregisters the host with its own
 * token and revokes every members share made under the registration, on both
 * sides; sharing with members again registers anew.
 *
 * With no registration it renders nothing — the share dialog registers on
 * demand — unless the server dropped the host, which is worth saying.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { endCollabFileHost } from "@/lib/collab/file-host"
import { fileShareErrorDetails, getCollabHostStatus } from "@/lib/filespace/grants-client"
import type { CollabHostStatus } from "@/types/filespace/live"

/**
 * The problems the host reports by code (`code` or `code: detail`); anything
 * else is shown as `other` with its text.
 */
const KNOWN_PROBLEMS = [
  "host_unregistered",
  "host_token_missing",
  "org_policy",
  "mirror_rejected",
  "rejected",
  "unreachable",
  "conflict",
] as const

type Problem = { code: (typeof KNOWN_PROBLEMS)[number] | "other"; detail: string }

/** Split the host's `lastError` into a known code and its detail. */
export function readCollabHostProblem(lastError: string | null): Problem | null {
  if (!lastError) return null
  const cut = lastError.indexOf(":")
  const head = (cut < 0 ? lastError : lastError.slice(0, cut)).trim()
  const detail = cut < 0 ? "" : lastError.slice(cut + 1).trim()
  const known = KNOWN_PROBLEMS.find((code) => code === head)
  return known ? { code: known, detail } : { code: "other", detail: lastError }
}

export interface CollabHostStatusDeps {
  getStatus: typeof getCollabHostStatus
  endHost: typeof endCollabFileHost
}

const defaultDeps: CollabHostStatusDeps = {
  getStatus: getCollabHostStatus,
  endHost: endCollabFileHost,
}

export interface CollabHostStatusBlockProps {
  /** The local conversation. */
  sessionId: string
  /** The host its files live on. */
  hostId?: string
  /**
   * Changes whenever the section's grants do, so the block reads the host
   * again (a new members share may have registered it).
   */
  refreshKey: string
  /** Members shares ended; the section reads its grants again. */
  onEnded: () => void
  deps?: CollabHostStatusDeps
}

export function CollabHostStatusBlock({
  sessionId,
  hostId,
  refreshKey,
  onEnded,
  deps = defaultDeps,
}: CollabHostStatusBlockProps) {
  const t = useTranslations("liveShare")
  const [loaded, setLoaded] = useState<{
    status: CollabHostStatus | null
    error: { code: string; message: string } | null
  } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [ending, setEnding] = useState(false)
  const [reads, setReads] = useState(0)

  useEffect(() => {
    let cancelled = false
    deps.getStatus(sessionId, { hostId }).then(
      (status) => {
        if (!cancelled) setLoaded({ status, error: null })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: null, error: fileShareErrorDetails(error) })
      }
    )
    return () => {
      cancelled = true
    }
    // `refreshKey` and `reads` only ask for a fresh read.
  }, [deps, sessionId, hostId, refreshKey, reads])

  const end = async () => {
    setEnding(true)
    try {
      await deps.endHost({ id: sessionId }, { hostId })
      toast.success(t("collabHost.stopped"))
    } catch (error) {
      const { code, message } = fileShareErrorDetails(error)
      toast.error(t(`errors.${code}`, { message }))
    } finally {
      setEnding(false)
      setReads((n) => n + 1)
      onEnded()
    }
  }

  if (!loaded) return null
  if (loaded.error) {
    return (
      <p
        role="alert"
        className="mb-2 text-xs text-destructive"
        data-testid="collab-host-status-error"
      >
        {t(`errors.${loaded.error.code}`, { message: loaded.error.message })}
      </p>
    )
  }
  const status = loaded.status
  if (!status) return null
  const problem = readCollabHostProblem(status.lastError)
  const registration = status.registration

  if (!registration) {
    if (problem?.code !== "host_unregistered" && problem?.code !== "host_token_missing") return null
    return (
      <p className="mb-2 text-xs text-muted-foreground" data-testid="collab-host-status">
        {t(`collabHost.problem.${problem.code}`, { detail: problem.detail })}
      </p>
    )
  }

  return (
    <div
      className="mb-2 space-y-1 rounded-md border px-2.5 py-2 text-xs"
      data-testid="collab-host-status"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 font-medium">
          <UsersIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {status.running
              ? t("collabHost.serving", { label: registration.hostLabel })
              : t("collabHost.notRunning", { label: registration.hostLabel })}
          </span>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          disabled={ending}
          onClick={() => setConfirming(true)}
        >
          {t("collabHost.stop")}
        </Button>
      </div>
      {status.unmirroredGrants > 0 ? (
        <p className="text-muted-foreground">
          {t("collabHost.pending", { count: status.unmirroredGrants })}
        </p>
      ) : null}
      {problem ? (
        <p role="status" className="text-destructive">
          {t(`collabHost.problem.${problem.code}`, { detail: problem.detail })}
        </p>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("collabHost.stopConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("collabHost.stopConfirm.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                void end()
              }}
            >
              {t("collabHost.stopConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
