"use client"

/**
 * Mobile Settings panel (Wave 2.7).
 *
 * Surfaces a small subset of `AppSettings` that's safe + useful from a
 * phone: theme, language, font scale, default model, biometric toggles.
 * Optimistic local Dexie write via the shared settings store, then
 * enqueues `app_settings_update` so the desktop reflects the same change
 * on next sync.
 *
 * The server-side allowlist (`APP_SETTINGS_MOBILE_ALLOWED_KEYS` in
 * `companion_api/rpc.rs`) rejects keys outside the safe list, so any
 * field added here that isn't in that allowlist will receive a 400.
 *
 * ADR-0021 follow-up — also renders a read-only transport-tier row that
 * subscribes to `CompanionTransport.onTierChange` so the user can see
 * whether they're reaching the desktop over WebRTC, LAN HTTPS, or a
 * tunnel. The row is hidden outside of Capacitor (the web/dev runtime
 * uses a stub transport that doesn't have a meaningful tier).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { isCapacitor, transport } from "@/lib/tauri"
import type { TransportTier } from "@/lib/tauri/transport-companion"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppLanguage, AppTheme, BiometricGuardPolicy } from "@/lib/claude/types"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"
import { localeNames, locales } from "@/lib/i18n/config"
import { useSettingsStore } from "@/stores/settings"

export function MobileSettingsPanel() {
  const t = useTranslations("mobile.settingsPanel")
  const tSec = useTranslations("mobile.security")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const theme = (settings?.theme ?? "system") as AppTheme
  const language = (settings?.language ?? "en") as AppLanguage
  const fontScale = settings?.fontScale ?? "md"
  const defaultModel = settings?.defaultModel ?? ""
  const policy: BiometricGuardPolicy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD

  const update = async (patch: Partial<NonNullable<typeof settings>>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: t("queueLabel", { keys }),
    })
  }

  const updateBiometric = (patch: Partial<BiometricGuardPolicy>) =>
    update({ biometricRequiredFor: { ...policy, ...patch } })

  return (
    <div className="space-y-4" data-testid="mobile-settings-panel">
      <TransportTierIndicator />
      <Row label={t("theme")}>
        <Select value={theme} onValueChange={(v) => void update({ theme: v as AppTheme })}>
          <SelectTrigger data-testid="settings-theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t("themeSystem")}</SelectItem>
            <SelectItem value="light">{t("themeLight")}</SelectItem>
            <SelectItem value="dark">{t("themeDark")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("language")}>
        <Select value={language} onValueChange={(v) => void update({ language: v as AppLanguage })}>
          <SelectTrigger data-testid="settings-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {locales.map((loc) => (
              <SelectItem key={loc} value={loc}>
                {localeNames[loc]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("fontScale")}>
        <Select value={fontScale} onValueChange={(v) => void update({ fontScale: v as never })}>
          <SelectTrigger data-testid="settings-font-scale">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sm">{t("fontScaleSm")}</SelectItem>
            <SelectItem value="md">{t("fontScaleMd")}</SelectItem>
            <SelectItem value="lg">{t("fontScaleLg")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("defaultModel")}>
        <Input
          value={defaultModel}
          onChange={(e) => void update({ defaultModel: e.target.value || undefined })}
          placeholder="claude-sonnet-4-6"
          data-testid="settings-default-model"
        />
      </Row>

      <section className="space-y-3 pt-2" data-testid="mobile-settings-biometric">
        <div className="space-y-0.5">
          <h3 className="text-xs font-semibold">{tSec("title")}</h3>
          <p className="text-[11px] text-muted-foreground">{tSec("description")}</p>
        </div>
        <BiometricRow
          label={tSec("deletePairing.label")}
          help={tSec("deletePairing.help")}
          checked={policy.deletePairing}
          onChange={(v) => void updateBiometric({ deletePairing: v })}
          testid="biometric-delete-pairing"
        />
        <BiometricRow
          label={tSec("exportBackup.label")}
          help={tSec("exportBackup.help")}
          checked={policy.exportBackup}
          onChange={(v) => void updateBiometric({ exportBackup: v })}
          testid="biometric-export-backup"
        />
        <BiometricRow
          label={tSec("revealSecrets.label")}
          help={tSec("revealSecrets.help")}
          checked={policy.revealSecrets}
          onChange={(v) => void updateBiometric({ revealSecrets: v })}
          testid="biometric-reveal-secrets"
        />
      </section>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Label className="flex flex-col gap-1 text-xs font-medium">
      <span>{label}</span>
      {children}
    </Label>
  )
}

function BiometricRow({
  label,
  help,
  checked,
  onChange,
  testid,
}: {
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
  testid: string
}) {
  return (
    <Item size="sm" className="px-0">
      <ItemContent>
        <ItemTitle className="text-xs">{label}</ItemTitle>
        <ItemDescription className="text-[11px]">{help}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          data-testid={testid}
          aria-label={label}
        />
      </ItemActions>
    </Item>
  )
}

// ---------------------------------------------------------------------------
// Transport tier indicator — ADR-0021 follow-up
// ---------------------------------------------------------------------------

/** Maps `TransportTier` → a Tailwind color class for the colored dot. */
const TIER_COLOR: Record<TransportTier, string> = {
  "rtc-direct": "fill-emerald-500 text-emerald-500",
  "rtc-relay": "fill-emerald-500 text-emerald-500",
  "ws-lan": "fill-sky-500 text-sky-500",
  "ws-tunnel": "fill-amber-500 text-amber-500",
  offline: "fill-muted-foreground text-muted-foreground",
}

/** Maps `TransportTier` → the i18n key suffix under `mobile.transportTier`. */
const TIER_KEY: Record<TransportTier, string> = {
  "rtc-direct": "rtcDirect",
  "rtc-relay": "rtcRelay",
  "ws-lan": "wsLan",
  "ws-tunnel": "wsTunnel",
  offline: "offline",
}

/**
 * Read-only row showing how the mobile client is currently reaching the
 * desktop. Subscribes to `CompanionTransport.onTierChange` so the value
 * stays live without polling. Hidden outside Capacitor — the web stub
 * doesn't have a meaningful tier.
 */
export function TransportTierIndicator(): React.JSX.Element | null {
  const t = useTranslations("mobile.settingsPanel")
  const tt = useTranslations("mobile.transportTier")
  // Default to "offline" for the SSR / first-paint case; the effect below
  // will overwrite immediately on Capacitor.
  const [tier, setTier] = useState<TransportTier>("offline")
  const [active, setActive] = useState<boolean>(false)
  const [reconnecting, setReconnecting] = useState(false)

  useEffect(() => {
    // The CompanionTransport singleton exposes `getActiveTier` /
    // `onTierChange`; the Tauri + web stubs do not. Duck-type so a
    // mocked transport in tests also lights up the row.
    if (!isCapacitor()) return
    const candidate = transport as unknown as {
      getActiveTier?: () => TransportTier
      onTierChange?: (h: (t: TransportTier) => void) => () => void
    }
    if (
      typeof candidate.getActiveTier !== "function" ||
      typeof candidate.onTierChange !== "function"
    ) {
      return
    }
    // SSR-safe init: the transport singleton isn't accessible during the
    // server / first paint, so we must seed `tier` + `active` once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(true)

    setTier(candidate.getActiveTier())
    return candidate.onTierChange((next) => setTier(next))
  }, [])

  const onReconnect = useCallback(() => {
    const candidate = transport as unknown as { reconnectRtc?: () => boolean }
    if (typeof candidate.reconnectRtc !== "function") {
      // Not on Capacitor build, or the singleton hasn't been upgraded —
      // refuse silently. The button only renders when `active`, which is
      // already a Capacitor-only flag, so this branch is defensive only.
      return
    }
    setReconnecting(true)
    try {
      const ok = candidate.reconnectRtc()
      if (ok) {
        toast.success(t("reconnectSuccess"))
      } else {
        toast.warning(t("reconnectInactive"))
      }
    } catch (err) {
      toast.error(
        t("reconnectFailed", {
          reason: err instanceof Error ? err.message : String(err),
        })
      )
    } finally {
      // `reconnectRtc` is fire-and-forget — the actual handshake runs
      // asynchronously inside `TransportRtc`. We surface a short busy
      // window so the button doesn't flicker, then fall back to the live
      // tier indicator for visibility.
      setTimeout(() => setReconnecting(false), 800)
    }
  }, [t])

  if (!active) return null

  const key = TIER_KEY[tier]
  // Show the reconnect affordance only when an RTC tier is involved.
  // For ws-* / offline the button would be a no-op (`reconnectRtc()`
  // returns false), so we hide it instead of confusing the user.
  const canReconnect = tier === "rtc-direct" || tier === "rtc-relay"

  return (
    <section
      className="flex flex-col gap-1 rounded border bg-card px-3 py-2 text-xs"
      data-testid="mobile-transport-tier"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("transportTier")}</span>
        <span className="flex items-center gap-1.5">
          <CircleIcon aria-hidden="true" className={cn("size-2 shrink-0", TIER_COLOR[tier])} />
          <span className="text-xs">{tt(key)}</span>
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">{tt(`${key}Description`)}</p>
      {canReconnect ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-end h-7 px-2 text-[11px]"
          disabled={reconnecting}
          onClick={onReconnect}
          data-testid="mobile-transport-tier-reconnect"
        >
          <RefreshCwIcon
            aria-hidden="true"
            className={cn("size-3 mr-1", reconnecting && "animate-spin")}
          />
          {t("reconnectButton")}
        </Button>
      ) : null}
    </section>
  )
}
