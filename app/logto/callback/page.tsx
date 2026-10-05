"use client"

/**
 * Where a web sign-in popup lands (`/logto/callback`), for a self-hosted
 * Logto and the official Cognia account alike.
 *
 * The page validates the state, hands the code to the window that opened it,
 * and closes. It is still a page a person sees: for a moment on success, and
 * for as long as it takes to read when something went wrong. So it says which
 * of these happened, in the card the identity Worker's hosted pages use, under
 * the same chibi spot icon for the outcome (scripts/build/build-sign-in-icons.mjs):
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
import { LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MobileSpotIcon, type MobileSpotIconName } from "@/components/mobile/mobile-spot-icon"
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
  const icon: MobileSpotIconName =
    outcome.kind === "working"
      ? "network"
      : outcome.kind === "done"
        ? "workspace-trust"
        : "diagnostics"

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground"
      data-testid="logto-callback"
      data-outcome={outcome.kind}
    >
      <section className="relative w-full max-w-md overflow-hidden rounded-3xl border bg-card text-center shadow-xl">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-transparent via-primary/70 to-transparent"
        />
        <div className="flex h-44 items-center justify-center border-b bg-gradient-to-b from-primary/10 to-transparent">
          <MobileSpotIcon name={icon} size={148} className="drop-shadow-lg" />
        </div>

        <div className="flex flex-col items-center gap-3 px-8 pt-7 pb-8">
          {outcome.kind === "working" ? (
            <Heading>
              <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" aria-hidden />
              {t("working")}
            </Heading>
          ) : null}

          {outcome.kind === "done" ? (
            <>
              <Heading>{t("doneTitle")}</Heading>
              <p className="text-sm text-muted-foreground">{t("doneBody")}</p>
              <CloseButton onClick={close}>{t("close")}</CloseButton>
            </>
          ) : null}

          {outcome.kind === "failed" ? (
            <>
              <Heading>{t("failedTitle")}</Heading>
              <p className="text-sm text-muted-foreground" data-testid="logto-callback-reason">
                {outcome.error === "access_denied"
                  ? t("cancelled")
                  : outcome.error === "state_mismatch"
                    ? t("stateMismatch")
                    : t("providerError", { error: outcome.error })}
              </p>
              <p className="text-xs text-muted-foreground">{t("tryAgain")}</p>
              <CloseButton onClick={close}>{t("close")}</CloseButton>
            </>
          ) : null}

          {outcome.kind === "orphaned" ? (
            <>
              <Heading>{t("orphanedTitle")}</Heading>
              <p className="text-sm text-muted-foreground">{t("orphanedBody")}</p>
              <CloseButton onClick={close}>{t("close")}</CloseButton>
            </>
          ) : null}
        </div>
      </section>
    </main>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight" role="status">
      {children}
    </h1>
  )
}

function CloseButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="outline" size="lg" className="mt-2 w-full" onClick={onClick}>
      {children}
    </Button>
  )
}
