"use client"

import { InfoIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Surface } from "@/components/surface/surface"
import type { HostAdminBlock } from "@/lib/connectivity/host-admin-reach"
import { cn } from "@/lib/utils"

export interface HostReachNoticeProps {
  block: HostAdminBlock
  className?: string
  testid?: string
}

/**
 * Why a Host control cannot run from here, and what would make it run.
 *
 * Rendered in place of a hidden control: a phone paired to a desktop, a
 * browser on a headless server and a standalone tab are three different
 * situations, and each gets its own sentence rather than a shared gap.
 */
export function HostReachNotice({ block, className, testid }: HostReachNoticeProps) {
  const t = useTranslations("settings.connectivity")
  return (
    <Surface asChild layer="base" radius="control">
      <p
        role="status"
        data-testid={testid}
        data-reach={block}
        className={cn(
          "flex items-start gap-2 border border-border/60 px-3 py-2 text-xs text-muted-foreground",
          className
        )}
      >
        <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          <span className="block text-foreground/90">{t(`reach.${block}`)}</span>
          <span className="mt-0.5 block">{t(`reachNext.${block}`)}</span>
        </span>
      </p>
    </Surface>
  )
}
