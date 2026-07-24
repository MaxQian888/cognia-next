"use client"

/**
 * /lark/shortcut — landing page for Feishu message shortcuts and the
 * `+`-menu import entry (plan 2026-07-24 P5). All flow logic lives in the
 * unit-tested `lib/connectors/lark-web/intent-client` (launch parsing,
 * JSSDK exchange, submit, poll); this page only sequences the JSSDK
 * bootstrap and renders the terminal outcomes.
 */

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { parseShortcutLaunch, runShortcutImportFlow } from "@/lib/connectors/lark-web/intent-client"
import {
  configureLarkJsSdk,
  getLarkTriggerDetail,
  loadLarkJsSdkScript,
} from "@/lib/connectors/lark-web/jssdk"

const KNOWN_ERROR_CODES = new Set([
  "adapter_missing",
  "trigger_missing",
  "trigger_detail_failed",
  "no_messages_selected",
  "membership_denied",
  "feature_disabled",
  "forbidden",
  "unbound",
  "timeout",
])

type ViewState =
  | { phase: "preparing" }
  | { phase: "importing" }
  | { phase: "login" }
  | { phase: "done" }
  | { phase: "error"; code: string }

function LarkShortcutInner() {
  const t = useTranslations("larkEntry")
  const router = useRouter()
  const [state, setState] = useState<ViewState>({ phase: "preparing" })
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const run = async () => {
      const search = window.location.search
      const returnTo = `${window.location.pathname}${search}`
      // JSSDK bootstrap is best-effort: when Feishu pre-injects the SDK the
      // load resolves instantly; a failed config surfaces later as
      // trigger_detail_failed with a precise message.
      const launch = parseShortcutLaunch(search)
      try {
        await loadLarkJsSdkScript()
        if (launch.adapterId) {
          await configureLarkJsSdk({
            adapterId: launch.adapterId,
            url: `${window.location.origin}${window.location.pathname}${search}`,
          })
        }
      } catch {
        // Continue — getLarkTriggerDetail reports the actionable failure.
      }
      setState({ phase: "importing" })
      const outcome = await runShortcutImportFlow({
        search,
        returnTo,
        getTriggerDetail: getLarkTriggerDetail,
      })
      if (outcome.kind === "navigate") {
        setState({ phase: "done" })
        router.replace(`/inbox/c?key=${encodeURIComponent(outcome.conversationKey)}`)
        return
      }
      if (outcome.kind === "login") {
        setState({ phase: "login" })
        window.location.assign(outcome.loginUrl)
        return
      }
      setState({
        phase: "error",
        code: KNOWN_ERROR_CODES.has(outcome.code) ? outcome.code : "import_failed",
      })
    }
    void run()
  }, [router])

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center" data-testid="lark-shortcut">
        <h1 className="text-lg font-semibold">{t("shortcut.title")}</h1>
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
            {state.phase === "preparing" && t("shortcut.preparing")}
            {state.phase === "importing" && t("shortcut.importing")}
            {state.phase === "done" && t("shortcut.done")}
            {state.phase === "login" && t("loginRedirect")}
          </p>
        )}
      </div>
    </main>
  )
}

export default function LarkShortcutPage() {
  return (
    <Suspense fallback={null}>
      <LarkShortcutInner />
    </Suspense>
  )
}
