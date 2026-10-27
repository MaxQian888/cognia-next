"use client"

/**
 * A compact, dismissible pointer to External Agents above AI Connections.
 * Agent details and credentials belong in that settings section. Dismissal
 * stays on this device, matching the adjacent provider host notices.
 */

import { useState } from "react"
import Link from "next/link"
import { ArrowRightIcon, BotIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { readDismiss, safeStorage, writeDismiss } from "@/lib/inbox/notice-dismiss"
import { cn } from "@/lib/utils"

import type { ExternalRuntimeConnections } from "./use-external-runtime-connections"

/** The External Agents settings section, which owns these agents' credentials. */
export const EXTERNAL_AGENTS_SETTINGS_HREF = "/settings?section=agents"

const DISMISS_KEY = "settings.externalRuntimeConnections.dismiss"
const DISMISS_ID = "external-runtimes"

export function ExternalRuntimeConnectionsCard({
  connections,
  className,
}: {
  connections: ExternalRuntimeConnections
  className?: string
}) {
  const t = useTranslations("providers.externalRuntimes")
  const tCommon = useTranslations("common")
  const [dismissed, setDismissed] = useState(
    () => readDismiss(DISMISS_KEY, safeStorage("local"))?.hash === DISMISS_ID
  )
  const { rows, workingCount } = connections
  if (rows.length === 0 || dismissed) return null

  return (
    <section
      className={cn("@container/provider-runtimes rounded-lg border px-4 py-3", className)}
      aria-labelledby="external-runtime-connections-title"
      data-testid="external-runtime-connections"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <BotIcon className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 id="external-runtime-connections-title" className="text-sm font-medium">
              {t("title")}
            </h3>
            <Badge
              variant="secondary"
              className="h-5 px-1.5 text-[10px] font-normal"
              data-testid="external-runtime-summary"
            >
              {t("summary", { working: workingCount, total: rows.length })}
            </Badge>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs @lg/provider-runtimes:ml-auto"
            >
              <Link href={EXTERNAL_AGENTS_SETTINGS_HREF}>
                {t("manage")}
                <ArrowRightIcon className="size-3" aria-hidden />
              </Link>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tCommon("dismiss")}
          title={tCommon("dismiss")}
          onClick={() => {
            writeDismiss(DISMISS_KEY, DISMISS_ID, safeStorage("local"))
            setDismissed(true)
          }}
        >
          <XIcon className="size-4" aria-hidden />
        </Button>
      </div>
    </section>
  )
}
