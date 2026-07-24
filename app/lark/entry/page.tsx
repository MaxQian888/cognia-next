"use client"

/**
 * /lark/entry?entry=…|surface=… — landing page for authorized Feishu deep
 * links (plan 2026-07-24 P3.3). All token/SSO/poll logic lives in the
 * unit-tested `lib/connectors/lark-web/entry-client`; this page only renders
 * the three terminal outcomes: navigate into the conversation, bounce to the
 * companion's Feishu SSO login, or an i18n'd error with a workbench fallback.
 */

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { resolveLarkEntry, type LarkEntryOutcome } from "@/lib/connectors/lark-web/entry-client"

type EntryErrorCode = Extract<LarkEntryOutcome, { kind: "error" }>["code"]

type ViewState =
  { phase: "resolving" } | { phase: "login" } | { phase: "error"; code: EntryErrorCode }

function LarkEntryInner() {
  const t = useTranslations("larkEntry")
  const router = useRouter()
  const [state, setState] = useState<ViewState>({ phase: "resolving" })
  // Entry tokens are single-use (jti consumed server-side) — StrictMode's
  // double effect invocation must not resolve the same token twice.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void resolveLarkEntry({
      search: window.location.search,
      returnTo: `${window.location.pathname}${window.location.search}`,
    }).then((outcome) => {
      if (outcome.kind === "navigate") {
        router.replace(`/inbox/c?key=${encodeURIComponent(outcome.conversationKey)}`)
        return
      }
      if (outcome.kind === "login") {
        setState({ phase: "login" })
        window.location.assign(outcome.loginUrl)
        return
      }
      setState({ phase: "error", code: outcome.code })
    })
  }, [router])

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center" data-testid="lark-entry">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {state.phase === "error" ? (
          <>
            <p className="text-sm text-muted-foreground">{t(`errors.${state.code}`)}</p>
            <Button asChild variant="outline">
              <Link href="/">{t("openWorkbench")}</Link>
            </Button>
          </>
        ) : (
          <p
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {state.phase === "login" ? t("loginRedirect") : t("resolving")}
          </p>
        )}
      </div>
    </main>
  )
}

export default function LarkEntryPage() {
  return (
    <Suspense fallback={null}>
      <LarkEntryInner />
    </Suspense>
  )
}
