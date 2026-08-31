"use client"

/**
 * Surfaces an adapter whose outbound queue cap has tripped repeatedly, with a
 * CTA into the Outbound tab so the operator can clear the backlog.
 *
 * Presentation only — `useOutboundSaturation` owns the audit query, the
 * threshold and the per-set dismiss; `InboxNoticeArea` decides whether to
 * mount it.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { SaturatedAdapter } from "@/hooks/connectors/use-outbound-saturation"
import { connectionsHref } from "@/lib/settings/deep-link"
import { NoticeItem } from "./notices/notice-item"

export interface OutboundSaturationNoticeProps {
  adapters: SaturatedAdapter[]
  onDismiss: () => void
}

export function OutboundSaturationNotice({ adapters, onDismiss }: OutboundSaturationNoticeProps) {
  const t = useTranslations("inbox.banner.outboundSaturated")

  if (adapters.length === 0) return null

  return (
    <NoticeItem
      severity="danger"
      data-testid="outbound-saturation-banner"
      title={
        <span data-testid="outbound-saturation-banner-headline">
          {t("headline", { count: adapters.length })}
        </span>
      }
      onDismiss={onDismiss}
      dismissLabel={t("dismiss")}
      dismissTestId="outbound-saturation-dismiss"
      actions={
        <Button
          asChild
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          data-testid="outbound-saturation-view"
        >
          <Link href={connectionsHref({ tab: "outbound" })}>
            {t("viewOutbound")}
            <ArrowRightIcon className="ml-1 size-3" aria-hidden />
          </Link>
        </Button>
      }
    >
      <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {adapters.map((adapter) => (
          <li
            key={adapter.adapterId}
            className="flex items-center gap-1.5"
            data-testid={`outbound-saturation-row-${adapter.adapterId}`}
          >
            <span className="font-mono text-[11px]">{adapter.adapterId}</span>
            <span className="text-muted-foreground">
              {t("count", { count: adapter.cappedCount })}
            </span>
          </li>
        ))}
      </ul>
    </NoticeItem>
  )
}
