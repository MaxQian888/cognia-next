"use client"

/**
 * Invitation landing: `/invite?token=…`.
 *
 * Reachable before anybody is signed in, which is the whole point. The token
 * is kept for the tab and the person is sent to the root, where the cloud
 * gate redeems it the moment there is a session to redeem it with. Nothing
 * here talks to a server: a page that redeemed on arrival would spend a
 * one-time token on a person who has not proven who they are yet.
 */

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { MailIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { rememberPendingInvitation } from "@/lib/identity/pending-invitation"

/**
 * `useSearchParams` must sit under a Suspense boundary or the static export
 * refuses to prerender the route. Same split every other query-reading page
 * in `app/` makes.
 */
export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <InviteLanding />
    </Suspense>
  )
}

function InviteLanding() {
  const t = useTranslations("account.invite")
  const router = useRouter()
  const params = useSearchParams()
  const [state, setState] = useState<"pending" | "kept" | "invalid">("pending")

  useEffect(() => {
    const token = params.get("token") ?? ""
    // Deferred so the verdict is not set synchronously inside the effect.
    queueMicrotask(() => setState(rememberPendingInvitation(token) ? "kept" : "invalid"))
  }, [params])

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground"
      data-testid="invite-page"
      data-state={state}
    >
      <section className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MailIcon className="size-5" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
        </div>
        {state === "invalid" ? (
          <p role="alert" className="text-sm text-destructive">
            {t("invalid")}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("received")}</p>
        )}
        <Button
          type="button"
          disabled={state === "pending"}
          onClick={() => router.replace("/")}
          data-testid="invite-continue"
        >
          {t("continue")}
        </Button>
      </section>
    </main>
  )
}
