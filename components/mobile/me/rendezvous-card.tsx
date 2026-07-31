"use client"

/**
 * Read-only view of the WebRTC rendezvous configuration this device is actually
 * using: the signaling endpoint it dials, and how many STUN / TURN servers it
 * has to work with.
 *
 * It exists because this was invisible and wrong at the same time. The phone
 * reads `signalingUrl` / `iceServers` / `turnServers` from its own settings row
 * (`lib/signaling/mobile-controller.ts`), but those fields were classified as
 * "the phone writes them up" and were never mirrored down — so pointing the
 * desktop at a self-hosted signaling server or an operator's TURN relay had no
 * effect here at all, and the only symptom was WebRTC quietly failing behind a
 * strict NAT. They are `server-authoritative` now, and this card is how you can
 * see which values arrived.
 *
 * Read-only on purpose: these belong to the deployment, not the handset. The
 * one genuinely per-device choice — whether to attempt the WebRTC tier — stays
 * device-local and is not shown here.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { MeSection } from "@/components/mobile/me/me-section"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { useSettingsStore } from "@/stores/settings"

/** Hide the query string — rendezvous ids do not belong on a settings screen. */
export function displaySignalingUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, "")
  } catch {
    return url
  }
}

export function RendezvousCard() {
  const t = useTranslations("mobile.network.rendezvous")
  const settings = useSettingsStore((s) => s.settings)

  const configuredUrl = settings?.signalingUrl
  const signalingUrl = configuredUrl ?? DEFAULT_SIGNALING_URL
  const stunCount = settings?.iceServers?.length ?? 0
  const turnCount = settings?.turnServers?.length ?? 0
  const providerKind = settings?.turnProvider?.kind ?? "none"

  return (
    <MeSection title={t("title")} description={t("description")} testid="me-section-rendezvous">
      <Item size="sm" className="px-0" data-testid="rendezvous-signaling">
        <ItemContent>
          <ItemTitle className="text-xs">{t("signalingLabel")}</ItemTitle>
          <ItemDescription className="break-all font-mono text-[11px]">
            {displaySignalingUrl(signalingUrl)}
          </ItemDescription>
        </ItemContent>
        <Badge variant={configuredUrl ? "default" : "outline"}>
          {configuredUrl ? t("sourceHost") : t("sourceBuiltIn")}
        </Badge>
      </Item>

      <Item size="sm" className="px-0" data-testid="rendezvous-stun">
        <ItemContent>
          <ItemTitle className="text-xs">{t("stunLabel")}</ItemTitle>
        </ItemContent>
        <Badge variant="secondary">{t("serverCount", { count: stunCount })}</Badge>
      </Item>

      <Item size="sm" className="px-0" data-testid="rendezvous-turn">
        <ItemContent>
          <ItemTitle className="text-xs">{t("turnLabel")}</ItemTitle>
          <ItemDescription>{t(`provider.${providerKind}`)}</ItemDescription>
        </ItemContent>
        <Badge variant={turnCount > 0 || providerKind !== "none" ? "secondary" : "outline"}>
          {t("serverCount", { count: turnCount })}
        </Badge>
      </Item>
    </MeSection>
  )
}
