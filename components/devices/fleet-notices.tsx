"use client"

/**
 * What the console has to say about the fleet as a whole, rather than about
 * the device that is open.
 *
 * These used to sit above the device masthead in the detail pane, which made
 * them read as facts about the selected device and pushed its name down the
 * screen. They are about the list: "this is the local record, not the host's"
 * qualifies every row's lifecycle state, and "only this machine" is the empty
 * state of the fleet. So they now live in the rail, which is also the half of
 * the console the phone shell shows first, and which previously showed
 * neither: the phone body never rendered these at all.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { QrCodeIcon, ServerIcon, XIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

/**
 * Without the host, lifecycle state and the raw capability sets come from the
 * local mirror, so `partial` grants and CLI-side suspensions cannot be seen.
 * Stated rather than swallowed.
 */
export function HostUnreachableNotice() {
  const t = useTranslations("devices")
  return (
    <Alert className="px-3 py-2" data-testid="device-host-unreachable">
      <AlertTitle className="text-xs">{t("hostUnreachableTitle")}</AlertTitle>
      <AlertDescription className="text-[11px] leading-snug">
        {t("hostUnreachableBody")}
      </AlertDescription>
    </Alert>
  )
}

/**
 * A `?device=` link naming a device this fleet does not have.
 *
 * Revoked, removed, or from another account: the console shows this machine
 * instead, and without this the link looks broken rather than stale.
 */
export function MissingDeviceLinkNotice({
  deviceRef,
  onDismiss,
}: {
  deviceRef: string
  onDismiss: () => void
}) {
  const t = useTranslations("devices")
  return (
    <Alert className="relative px-3 py-2 pr-8" data-testid="device-link-missing">
      <AlertTitle className="text-xs">{t("missingLinkTitle")}</AlertTitle>
      <AlertDescription className="text-[11px] leading-snug">
        <span className="block">{t("missingLinkBody")}</span>
        <code className="mt-1 block truncate font-mono text-[10px]">{deviceRef}</code>
      </AlertDescription>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-1.5 right-1.5 size-6"
        aria-label={t("missingLinkDismiss")}
        onClick={onDismiss}
        data-testid="device-link-missing-dismiss"
      >
        <XIcon className="size-3.5" />
      </Button>
    </Alert>
  )
}

/**
 * The standalone console: no host of our own and none paired.
 *
 * This is the surface contract's `standalone: "explain"` state. The console
 * keeps working for this machine and says which half is missing, instead of
 * rendering a one-row "fleet" with nothing to explain it. Under the single
 * row rather than above the device pane, because it is the list's empty state.
 *
 * Two ways out, both reachable from here. Adding a host is the one a browser
 * can act on without another device in hand, so it leads.
 */
export function StandaloneFleetCard({
  onAddHost,
  pairHref,
}: {
  onAddHost: () => void
  pairHref: string
}) {
  const t = useTranslations("devices")
  return (
    <div
      className="rounded-lg border border-dashed p-3"
      data-testid="devices-requires-host"
      data-reason={standaloneDevicesRequiresHost.reason}
    >
      <p className="text-xs font-medium">{t("standaloneTitle")}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t("standaloneBody")}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button size="sm" onClick={onAddHost} data-testid="devices-standalone-add-host">
          <ServerIcon className="size-3.5" />
          {t("actions.addHost")}
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href={pairHref}>
            <QrCodeIcon className="size-3.5" />
            {t("standalonePair")}
          </Link>
        </Button>
      </div>
    </div>
  )
}
