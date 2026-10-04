"use client"

/**
 * Settings → Account → delete the official Cognia account (ADR-0215 §10).
 *
 * Three states, read from the identity Worker:
 *
 * - nothing pending: "Delete account" opens an inline confirmation that says
 *   what goes (the account and its linked sign-ins, after 7 days) and what
 *   stays (everything on this device), and offers a backup first. Confirming
 *   asks the person to sign in again; the request is made with that fresh
 *   sign-in (`confirmAccountDeletion`).
 * - pending: the purge date, and "Cancel deletion".
 * - the read failed: the reason, and a retry.
 *
 * The local profile is never touched here: deleting it is the Danger tab.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArchiveIcon, Trash2Icon, Undo2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  AccountDeletionError,
  cancelAccountDeletion,
  confirmAccountDeletion,
  readAccountDeletion,
  type OfficialDeletionState,
} from "@/lib/identity/official-account-deletion"
import { platformSignInDrivers } from "@/lib/logto/platform-drivers"
import { LogtoSignInCancelled } from "@/lib/logto/capacitor-drivers"

import type { OfficialDeployment } from "@/lib/identity/official-deployment"
import type { LogtoSession } from "@/lib/logto/client"

export interface OfficialAccountDeletionDeps {
  read?: typeof readAccountDeletion
  cancel?: typeof cancelAccountDeletion
  confirm?: typeof confirmAccountDeletion
  drivers?: typeof platformSignInDrivers
}

export interface OfficialAccountDeletionProps {
  deployment: OfficialDeployment
  /** The profile's active official session. */
  session: LogtoSession
  deps?: OfficialAccountDeletionDeps
}

type Phase = "idle" | "confirming" | "awaiting-sign-in" | "working"

function isCancel(cause: unknown): boolean {
  return (
    cause instanceof LogtoSignInCancelled || (cause instanceof Error && cause.name === "AbortError")
  )
}

export function OfficialAccountDeletion({
  deployment,
  session,
  deps = {},
}: OfficialAccountDeletionProps) {
  const t = useTranslations("account.identity.deletion")
  const [state, setState] = useState<OfficialDeletionState | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const signInWait = useRef<AbortController | null>(null)
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })

  const explain = useCallback(
    (cause: unknown): string => {
      if (cause instanceof AccountDeletionError) {
        if (cause.code === "different-person") return t("error.differentPerson")
        if (cause.code === "stale-sign-in") return t("error.staleSignIn")
        if (cause.code === "unauthorized") return t("error.unauthorized")
      }
      return t("error.generic", { message: cause instanceof Error ? cause.message : String(cause) })
    },
    [t]
  )

  // Read once per session: the translator takes a new identity on renders,
  // and a read that followed it would undo every state change it reports.
  const explainRef = useRef(explain)
  useEffect(() => {
    explainRef.current = explain
  })
  const load = useCallback(async () => {
    setReadError(null)
    try {
      setState(await (depsRef.current.read ?? readAccountDeletion)(session))
    } catch (cause) {
      setState(null)
      setReadError(explainRef.current(cause))
    }
  }, [session])

  useEffect(() => {
    queueMicrotask(() => void load())
    return () => signInWait.current?.abort()
  }, [load])

  const confirm = async () => {
    const controller = new AbortController()
    signInWait.current = controller
    const { drivers, redirectUri, clientKind } = (depsRef.current.drivers ?? platformSignInDrivers)(
      { issuerKind: deployment.issuerKind, signal: controller.signal }
    )
    setPhase("awaiting-sign-in")
    try {
      const next = await (depsRef.current.confirm ?? confirmAccountDeletion)(
        deployment,
        drivers,
        { redirectUri, clientKind },
        session
      )
      setState(next)
      setPhase("idle")
      toast.success(t("requested"))
    } catch (cause) {
      setPhase("confirming")
      if (!isCancel(cause)) toast.error(explain(cause))
    } finally {
      signInWait.current = null
    }
  }

  const cancelDeletion = async () => {
    setPhase("working")
    try {
      setState(await (depsRef.current.cancel ?? cancelAccountDeletion)(session))
      toast.success(t("cancelled"))
    } catch (cause) {
      toast.error(explain(cause))
    } finally {
      setPhase("idle")
    }
  }

  return (
    <section
      className="flex flex-col gap-2 border-t pt-4"
      data-testid="official-account-deletion"
      data-status={state?.status ?? (readError ? "error" : "loading")}
    >
      <h4 className="text-xs font-medium text-muted-foreground">{t("title")}</h4>

      {readError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-xs text-destructive">
            {readError}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => void load()}
            data-testid="official-account-deletion-retry"
          >
            {t("retry")}
          </Button>
        </div>
      ) : state === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3" />
          {t("loading")}
        </p>
      ) : state.status === "pending" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" data-testid="official-account-deletion-pending">
            {state.purgeAfter
              ? t("pending", { date: new Date(state.purgeAfter).toLocaleString() })
              : t("pendingNoDate")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={phase === "working"}
            onClick={() => void cancelDeletion()}
            data-testid="official-account-deletion-cancel"
          >
            <Undo2Icon data-icon="inline-start" />
            {t("cancel")}
          </Button>
        </div>
      ) : phase === "idle" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="self-start"
            onClick={() => setPhase("confirming")}
            data-testid="official-account-deletion-start"
          >
            <Trash2Icon data-icon="inline-start" />
            {t("delete")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="official-account-deletion-confirm">
          <p className="text-sm">{t("confirmBody")}</p>
          <p className="text-xs text-muted-foreground">{t("confirmLocal")}</p>
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href="/me/backup" data-testid="official-account-deletion-backup">
              <ArchiveIcon data-icon="inline-start" />
              {t("backupFirst")}
            </Link>
          </Button>
          {phase === "awaiting-sign-in" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3" />
              {t("awaitingSignIn")}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => signInWait.current?.abort()}
                data-testid="official-account-deletion-stop"
              >
                {t("stop")}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => void confirm()}
                data-testid="official-account-deletion-confirm-button"
              >
                {t("confirm")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPhase("idle")}
                data-testid="official-account-deletion-back"
              >
                {t("back")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default OfficialAccountDeletion
