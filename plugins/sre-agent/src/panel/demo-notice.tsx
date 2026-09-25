"use client"

import { FlaskConicalIcon } from "lucide-react"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"
import type { SreRuntime } from "../runtime"

/**
 * The panel's standing label that its evidence is the bundled demo corpus.
 *
 * One of the three places the demo status is stated (see `SreProviderKind`):
 * without it a recorded 2026-08 incident reads as the user's own production
 * logs. Rendered for as long as the runtime reports a demo backend — not a
 * dismissible hint, because the fact it states does not stop being true.
 */
export function DemoNotice({ runtime }: { runtime: SreRuntime }) {
  const t = usePluginTranslations(PLUGIN_ID)
  if (!runtime.provider().demo) return null
  return (
    <div
      role="note"
      className="flex shrink-0 items-start gap-2 border-b bg-muted/50 px-3 py-2 text-xs"
      data-testid="sre-demo-notice"
    >
      <FlaskConicalIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0">
        <span className="mr-1.5 font-medium">{t("demo.badge")}</span>
        <span className="text-muted-foreground">{t("demo.notice")}</span>
      </p>
    </div>
  )
}
