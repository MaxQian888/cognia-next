"use client"

/**
 * Where a web sign-in popup lands (`/logto/callback`), for a self-hosted
 * Logto and the official Cognia account alike.
 *
 * The page validates the state, hands the code to the window that opened it,
 * and closes. It is still a page a person sees: for a moment on success, and
 * for as long as it takes to read when something went wrong. So it says which
 * of these happened, in the same card the sign-in screen uses:
 *
 * - `done`: the code went back to Cognia; the window closes (a button covers
 *   a browser that refuses to let script close it);
 * - `failed`: the provider refused, the person cancelled, or the response does
 *   not belong to this sign-in (state mismatch). Nothing was sent as a code;
 * - `orphaned`: no opener to hand the code to (the popup was detached, or the
 *   address was opened by hand). Signing in has to start again from Cognia.
 */

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { readValidatedLogtoCallback } from "@/lib/logto/web-popup"

type Outcome =
  { kind: "working" } | { kind: "done" } | { kind: "failed"; error: string } | { kind: "orphaned" }

export default function LogtoCallbackPage() {
  const t = useTranslations("account.cloud.callback")
  const [outcome, setOutcome] = useState<Outcome>({ kind: "working" })

  useEffect(() => {
    const payload = readValidatedLogtoCallback(window.location.search)
    const opener = window.opener as Window | null
    if (opener) opener.postMessage(payload, window.location.origin)
    let next: Outcome
    if (payload.error) next = { kind: "failed", error: payload.error }
    else if (!opener) next = { kind: "orphaned" }
    else next = { kind: "done" }
    queueMicrotask(() => setOutcome(next))
    if (next.kind === "done") window.close()
  }, [])

  const close = () => window.close()

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground"
      data-testid="logto-callback"
      data-outcome={outcome.kind}
    >
      <section className="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm">
        {outcome.kind === "working" ? (
          <Heading icon={<LoaderCircleIcon className="size-5 animate-spin" aria-hidden />}>
            {t("working")}
          </Heading>
        ) : null}

        {outcome.kind === "done" ? (
          <>
            <Heading icon={<CircleCheckIcon className="size-5" aria-hidden />}>
              {t("doneTitle")}
            </Heading>
            <p className="text-sm text-muted-foreground">{t("doneBody")}</p>
            <Button type="button" variant="outline" onClick={close}>
              {t("close")}
            </Button>
          </>
        ) : null}

        {outcome.kind === "failed" ? (
          <>
            <Heading tone="destructive" icon={<CircleAlertIcon className="size-5" aria-hidden />}>
              {t("failedTitle")}
            </Heading>
            <p className="text-sm text-muted-foreground" data-testid="logto-callback-reason">
              {outcome.error === "access_denied"
                ? t("cancelled")
                : outcome.error === "state_mismatch"
                  ? t("stateMismatch")
                  : t("providerError", { error: outcome.error })}
            </p>
            <p className="text-xs text-muted-foreground">{t("tryAgain")}</p>
            <Button type="button" variant="outline" onClick={close}>
              {t("close")}
            </Button>
          </>
        ) : null}

        {outcome.kind === "orphaned" ? (
          <>
            <Heading tone="destructive" icon={<CircleAlertIcon className="size-5" aria-hidden />}>
              {t("orphanedTitle")}
            </Heading>
            <p className="text-sm text-muted-foreground">{t("orphanedBody")}</p>
            <Button type="button" variant="outline" onClick={close}>
              {t("close")}
            </Button>
          </>
        ) : null}
      </section>
    </main>
  )
}

function Heading({
  icon,
  tone = "primary",
  children,
}: {
  icon: ReactNode
  tone?: "primary" | "destructive"
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={
          tone === "destructive"
            ? "flex size-10 items-center justify-center rounded-lg bg-destructive/10 text-destructive"
            : "flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
        }
      >
        {icon}
      </div>
      <h1 className="text-base font-semibold" role="status">
        {children}
      </h1>
    </div>
  )
}
