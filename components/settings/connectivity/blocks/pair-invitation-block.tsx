"use client"

/**
 * Pairing → the owner invitation QR.
 *
 * Was `PairDeviceCard` in the retired companion section. New since ADR-0170:
 * the invitation may carry a relay room, in which case the payload is `cgnp4`
 * and the block says so, because that is the difference between "scan this on
 * the same Wi-Fi" and "scan this anywhere".
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, QrCodeIcon, WifiIcon } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { toast } from "sonner"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { useHostAdminReachForCommand } from "@/hooks/connectivity/use-host-admin-reach"
import { APP_VERSION } from "@/lib/app-version"
import { encodePairPayload, type PairRelay } from "@/lib/qr/pair-payload"
import { transport } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useAccountStore } from "@/stores/account/account-store"

import { HostReachNotice } from "./host-reach-notice"

/** Mirror of the Rust `OwnerInvitationIssue` (`companion_api/commands.rs`). */
export interface OwnerInvitationIssue {
  invitation: string
  expiresAtMs: number
  baseUrl: string
  fingerprint?: string
  appVersion?: string
  hostId: string
  tenantId: string
  /** ADR-0170: the one-shot relay room this invitation may be redeemed through. */
  relay?: PairRelay
}

export interface PairInvitationBlockProps {
  /** Test seam. Defaults to the routed `companion_create_owner_invitation`. */
  issue?: () => Promise<OwnerInvitationIssue>
}

const defaultIssue = () => transport.call<OwnerInvitationIssue>("companion_create_owner_invitation")

export function PairInvitationBlock({
  issue: issueInvitation = defaultIssue,
}: PairInvitationBlockProps) {
  const t = useTranslations("mobile.companion.pair")
  const tc = useTranslations("settings.connectivity.pairing")
  const reach = useHostAdminReachForCommand("companion_create_owner_invitation")
  const localAccountId = useAccountStore((state) => state.unlockedAccountId)
  const [issue, setIssue] = useState<OwnerInvitationIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!issue) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [issue])

  const onGenerate = useCallback(async () => {
    if (!reach.available) return
    if (!localAccountId) {
      toast.error(t("accountLocked"))
      return
    }
    setBusy(true)
    try {
      setIssue(await issueInvitation())
      setNow(Date.now())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [issueInvitation, localAccountId, reach.available, t])

  const expired = issue ? now >= issue.expiresAtMs : false
  const remainingSecs = issue ? Math.max(0, Math.floor((issue.expiresAtMs - now) / 1000)) : 0

  const qrPayload = useMemo(() => {
    if (!issue) return null
    return encodePairPayload({
      baseUrl: issue.baseUrl,
      mode: "owner-invitation",
      invitation: issue.invitation,
      hostId: issue.hostId,
      tenantId: issue.tenantId,
      expiresAt: issue.expiresAtMs,
      serverVersion: issue.appVersion ?? APP_VERSION,
      fingerprint: issue.fingerprint ?? "",
      ...(issue.relay ? { relay: issue.relay } : {}),
    })
  }, [issue])

  return (
    <SettingsBlock
      icon={<QrCodeIcon />}
      title={t("title")}
      description={t("description")}
      badge={
        issue ? (
          issue.relay ? (
            <Badge variant="secondary" className="gap-1 text-[10px]" data-testid="pair-reach-relay">
              <CloudIcon className="size-3" aria-hidden="true" />
              {tc("reachRelay")}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-[10px]" data-testid="pair-reach-direct">
              <WifiIcon className="size-3" aria-hidden="true" />
              {tc("reachDirect")}
            </Badge>
          )
        ) : null
      }
      action={
        <Button
          size="sm"
          onClick={() => void onGenerate()}
          disabled={!reach.available || busy}
          aria-label={t("generateAria")}
        >
          <QrCodeIcon className="mr-1 size-3.5" aria-hidden="true" />
          {issue ? t("refreshQr") : t("generateQr")}
        </Button>
      }
      testid="pair-invitation-block"
      settingId="companion-pair"
    >
      {reach.block ? <HostReachNotice block={reach.block} testid="pair-reach" /> : null}
      {issue ? (
        <p
          className={cn("text-xs", expired ? "text-destructive" : "text-muted-foreground")}
          aria-live="polite"
        >
          {expired ? t("expired") : t("expiresIn", { time: formatRemaining(remainingSecs) })}
        </p>
      ) : null}
      {issue && qrPayload && !expired ? (
        <Surface
          layer="raised"
          radius="control"
          className="flex w-full justify-center border border-border/60 p-4"
          data-testid="pair-qr-canvas"
        >
          <QRCodeSVG value={qrPayload} size={224} level="M" aria-label={t("qrAria")} />
        </Surface>
      ) : null}
      {issue ? (
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p className="break-all font-mono">{issue.baseUrl}</p>
          <p data-testid="pair-reach-hint">
            {issue.relay ? tc("reachRelayHint") : tc("reachDirectHint")}
          </p>
        </div>
      ) : null}
    </SettingsBlock>
  )
}

function formatRemaining(secs: number): string {
  const mm = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0")
  const ss = (secs % 60).toString().padStart(2, "0")
  return `${mm}:${ss}`
}
