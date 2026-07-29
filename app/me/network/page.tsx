"use client"

/**
 * Mobile Network page (ADR-0056, decision D6 — desktop-bound section,
 * read-only on mobile). The desktop Network section configures an HTTP/SOCKS
 * proxy (mode, host/port, auth, bypass) probed and applied via Tauri
 * `invoke()` — there is no proxy runtime on the phone, so editing stays
 * "manage on desktop".
 *
 * The one thing the phone CAN surface is its own live connectivity, read via
 * `lib/capacitor/network` (the `@capacitor/network` plugin with a
 * `navigator.onLine` fallback). This `<PairedOnly>` read view shows that
 * status and points proxy configuration at the desktop.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { RendezvousCard } from "@/components/mobile/me/rendezvous-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { getStatus, subscribe, type NetworkStatus } from "@/lib/capacitor/network"

function NetworkBody() {
  const t = useTranslations("mobile.network")
  const [status, setStatus] = useState<NetworkStatus | null>(null)

  useEffect(() => {
    let active = true
    let unsub: (() => void) | undefined
    void getStatus().then((res) => {
      if (active && res.kind !== "error") setStatus(res.status)
    })
    void subscribe((s) => {
      if (active) setStatus(s)
    }).then((u) => {
      if (active) unsub = u
      else u()
    })
    return () => {
      active = false
      unsub?.()
    }
  }, [])

  const connected = status?.connected ?? false
  const type = status?.connectionType ?? "unknown"

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="network-intro">
        {t("intro")}
      </p>

      <MeSection
        title={t("connectivity.title")}
        description={t("connectivity.description")}
        testid="me-section-network-connectivity"
      >
        <Item size="sm" className="px-0" data-testid="network-status">
          <ItemContent>
            <ItemTitle className="text-xs">{t("connectivity.statusLabel")}</ItemTitle>
          </ItemContent>
          <Badge variant={connected ? "default" : "outline"}>
            {connected ? t("connectivity.online") : t("connectivity.offline")}
          </Badge>
        </Item>
        <Item size="sm" className="px-0" data-testid="network-type">
          <ItemContent>
            <ItemTitle className="text-xs">{t("connectivity.typeLabel")}</ItemTitle>
          </ItemContent>
          <Badge variant="secondary">{t(`connectionType.${type}`)}</Badge>
        </Item>
      </MeSection>

      <RendezvousCard />

      <MeSection title={t("proxy.title")} testid="me-section-network-proxy">
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemDescription>{t("proxy.description")}</ItemDescription>
          </ItemContent>
        </Item>
      </MeSection>

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="network-manage-note"
      >
        <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>
    </div>
  )
}

export default function MobileNetworkPage() {
  const t = useTranslations("mobile.network")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-network-page">
      <PairedOnly>
        <NetworkBody />
      </PairedOnly>
    </SubPageShell>
  )
}
