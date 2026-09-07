"use client"

/**
 * Says out loud whether anything will actually run the Bots on this page.
 *
 * Every other control here is configuration, and configuration reads exactly
 * the same whether or not a runner exists. A standalone browser tab shows
 * armed triggers, bound credentials and an `enabled` status for a Bot that
 * will never fire once, and nothing else on the page distinguishes that from a
 * working installation.
 *
 * `local` is silent on purpose. A notice that appears in the healthy case is
 * one the reader learns to skip, and the healthy case is the one where the
 * rest of the console already tells the truth unaided.
 */

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { resolveBotRuntimeReach, type BotRuntimeReach } from "@/lib/bot/console/runtime-reach"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

/**
 * Re-read when this shell starts or stops driving a remote host.
 *
 * The same subscription `BotRuntimeInitializer` uses, for the same reason: a
 * desktop pairs with a remote Cognia long after boot, and a notice that read
 * the answer once at mount would keep claiming this machine is draining a
 * queue it has since handed over.
 */
function useBotRuntimeReach(): BotRuntimeReach {
  return useSyncExternalStore(
    (onChange) => subscribeActiveRemoteTransport(() => onChange()),
    () => resolveBotRuntimeReach(),
    // The server snapshot cannot consult a browser-only registry, and the
    // narrowest honest answer during prerender is "we do not know of a host".
    () => "none" as const
  )
}

export function BotRuntimeNotice() {
  const t = useTranslations("bots")
  const reach = useBotRuntimeReach()

  if (reach === "local") return null

  return (
    <Alert
      className="m-3 mb-0"
      variant={reach === "none" ? "destructive" : "default"}
      data-testid="bot-runtime-notice"
      data-reach={reach}
    >
      <AlertTitle>{t(`runtime.${reach}.title`)}</AlertTitle>
      <AlertDescription>{t(`runtime.${reach}.body`)}</AlertDescription>
    </Alert>
  )
}
