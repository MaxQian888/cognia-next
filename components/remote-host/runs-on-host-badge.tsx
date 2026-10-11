"use client"

/**
 * The mark of a placeholder (ADR-0224 A5): an item this device moved to a
 * paired host. Its row here is kept, disabled, and never run; this says so
 * where the item is listed, and links to the host's device page, where it can
 * be taken back.
 *
 * Renders nothing for an item that runs here, so callers can place it
 * unconditionally next to a status.
 */

import { ServerIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import { deviceConsoleHref } from "@/lib/devices/device-console-href"
import { isOwnedElsewhere } from "@/lib/placement/ownership"
import { cn } from "@/lib/utils"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { ItemOwner } from "@/types/placement/item-owner"

export interface RunsOnHostBadgeProps {
  owner: ItemOwner | undefined
  /** Off inside another control (a list row is a button), where a link cannot nest. */
  link?: boolean
  className?: string
}

export function RunsOnHostBadge({ owner, link = true, className }: RunsOnHostBadgeProps) {
  const t = useTranslations("devices.alwaysOn")
  const host = useRemoteHostStore((state) =>
    isOwnedElsewhere(owner)
      ? state.hosts.find((candidate) => candidate.id === owner.hostId)
      : undefined
  )
  if (!isOwnedElsewhere(owner)) return null
  // The console addresses a host by its published identity when it has one.
  const ref = host ? remoteHostRef(host) : `host:${owner.hostId}`
  const content = (
    <>
      <ServerIcon className="size-3" aria-hidden="true" />
      {t("badge.label", { host: owner.hostLabel })}
    </>
  )
  if (!link) {
    return (
      <Badge
        variant="secondary"
        className={cn("gap-1 text-[10px] font-normal", className)}
        title={t("badge.title", { host: owner.hostLabel })}
        data-testid="runs-on-host-badge"
      >
        {content}
      </Badge>
    )
  }
  return (
    <Badge
      asChild
      variant="secondary"
      className={cn("gap-1 text-[10px] font-normal", className)}
      data-testid="runs-on-host-badge"
    >
      <Link
        href={deviceConsoleHref(ref, "always-on")}
        title={t("badge.title", { host: owner.hostLabel })}
        onClick={(event) => event.stopPropagation()}
      >
        {content}
      </Link>
    </Badge>
  )
}
