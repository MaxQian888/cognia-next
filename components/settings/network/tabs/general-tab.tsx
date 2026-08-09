"use client"

/**
 * Settings → Network Proxy → General. Lets the user choose the proxy mode
 * (Off / Manual / Auto), pick a protocol, fill in host/port, optionally
 * supply credentials, and curate the bypass list.
 *
 * Text fields (host / port / credentials) are edited against **local draft
 * state** and only persisted on blur / Enter — not on every keystroke.
 * Persisting each keystroke round-trips through Dexie asynchronously; binding
 * the controlled `value` straight to that lagging store value dropped
 * characters and reverted the field mid-typing. Discrete controls (mode,
 * protocol, WebSocket toggle, bypass list) persist immediately since they
 * don't suffer the same lag.
 *
 * Every committed change writes a partial `networkProxy` patch via
 * `useSettingsStore` and mirrors the result into the Rust process via
 * `applyProxyToRust` (no-op on web).
 */

import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"

import { useSettingsStore } from "@/stores/settings"
import {
  applyProxyToRust,
  getProxyRuntimeStatus,
  updateProxyPassword,
} from "@/stores/network-proxy"
import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type NetworkProxySettings,
  type ProxyMode,
  type ProxyProtocol,
} from "@/types/network/proxy"

const MODE_VALUES: ProxyMode[] = ["off", "manual", "auto"]
const PROTOCOL_VALUES: ProxyProtocol[] = ["http", "https", "socks5"]

export function NetworkGeneralTab() {
  const t = useTranslations("settings.network")
  const settings = useSettingsStore((s) => s.settings?.networkProxy)
  const save = useSettingsStore((s) => s.save)

  const cfg: NetworkProxySettings = settings ?? DEFAULT_NETWORK_PROXY_SETTINGS

  const [bypassDraft, setBypassDraft] = useState("")

  // Local drafts for the free-text fields. Kept out of the store while typing
  // so the controlled inputs don't lag behind the async Dexie write.
  const [hostDraft, setHostDraft] = useState(cfg.host)
  const [portDraft, setPortDraft] = useState(cfg.port ? String(cfg.port) : "")
  const [usernameDraft, setUsernameDraft] = useState(cfg.username ?? "")
  const [passwordDraft, setPasswordDraft] = useState("")
  const [passwordIntent, setPasswordIntent] = useState<"keep" | "replace">("keep")
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  const [credentialError, setCredentialError] = useState(false)

  // Re-sync drafts whenever the persisted values change from *outside* this
  // tab (Detection-tab Apply, startup auto-detect). Firing on the concrete
  // field values — not object identity — avoids clobbering an in-progress edit
  // on unrelated re-renders while still catching external updates.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync drafts from external store changes
    setHostDraft(cfg.host)
    setPortDraft(cfg.port ? String(cfg.port) : "")
    setUsernameDraft(cfg.username ?? "")
  }, [cfg.host, cfg.port, cfg.username])

  useEffect(() => {
    let cancelled = false
    void getProxyRuntimeStatus()
      .then((status) => {
        if (!cancelled) setCredentialConfigured(status.credentialConfigured)
      })
      .catch(() => {
        if (!cancelled) setCredentialError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const persist = async (patch: Partial<NetworkProxySettings>) => {
    const next: NetworkProxySettings = { ...cfg, ...patch }
    await save({ networkProxy: next })
    void applyProxyToRust(next)
  }

  // Commit helpers — only persist when the draft actually differs from the
  // stored value so a plain focus/blur doesn't churn the store.
  const commitHost = () => {
    if (hostDraft !== cfg.host) void persist({ host: hostDraft })
  }
  const commitPort = () => {
    const clamped = Math.max(0, Math.min(65535, Number(portDraft) || 0))
    if (clamped !== cfg.port) void persist({ port: clamped })
  }
  const commitUsername = () => {
    const next = usernameDraft || undefined
    if (next !== (cfg.username || undefined)) void persist({ username: next })
  }
  const commitPassword = async () => {
    if (passwordIntent !== "replace" || !passwordDraft) return
    try {
      const configured = await updateProxyPassword({ kind: "replace", value: passwordDraft })
      setCredentialConfigured(configured)
      setPasswordDraft("")
      setPasswordIntent("keep")
      setCredentialError(false)
    } catch {
      setCredentialError(true)
    }
  }

  const clearPassword = async () => {
    try {
      await updateProxyPassword({ kind: "clear" })
      setCredentialConfigured(false)
      setPasswordDraft("")
      setPasswordIntent("keep")
      setCredentialError(false)
    } catch {
      setCredentialError(true)
    }
  }

  // Push the *current* config to Rust on first mount so a freshly-launched
  // app picks up the persisted proxy without waiting for a user edit.
  useEffect(() => {
    void applyProxyToRust(cfg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addBypass = async () => {
    const entry = bypassDraft.trim()
    if (!entry) return
    if (cfg.bypass.includes(entry)) {
      setBypassDraft("")
      return
    }
    await persist({ bypass: [...cfg.bypass, entry] })
    setBypassDraft("")
  }

  const removeBypass = async (entry: string) => {
    await persist({ bypass: cfg.bypass.filter((b) => b !== entry) })
  }

  const disabled = cfg.mode === "off"

  return (
    <div className="space-y-6">
      {/* Mode */}
      <div className="space-y-2">
        <Label className="text-sm">{t("modeLabel")}</Label>
        <RadioGroup
          value={cfg.mode}
          onValueChange={(v) => persist({ mode: v as ProxyMode })}
          className="flex flex-col gap-2"
        >
          {MODE_VALUES.map((m) => (
            <label key={m} className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value={m} id={`network-proxy-mode-${m}`} />
              <span className="text-sm">{t(`mode.${m}`)}</span>
              <span className="text-xs text-muted-foreground">{t(`modeHint.${m}`)}</span>
            </label>
          ))}
        </RadioGroup>
      </div>

      {/* Protocol */}
      <div className="space-y-2">
        <Label className="text-sm">{t("form.protocol")}</Label>
        <Select
          value={cfg.protocol}
          onValueChange={(v) => persist({ protocol: v as ProxyProtocol })}
          disabled={disabled}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROTOCOL_VALUES.map((p) => (
              <SelectItem key={p} value={p}>
                {p.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Host + Port */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-2 sm:col-span-2">
          <Label className="text-sm">{t("form.host")}</Label>
          <Input
            value={hostDraft}
            onChange={(e) => setHostDraft(e.target.value)}
            onBlur={commitHost}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            placeholder="127.0.0.1"
            disabled={disabled}
            aria-label={t("form.host")}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm">{t("form.port")}</Label>
          <Input
            type="number"
            min={0}
            max={65535}
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            placeholder="7890"
            disabled={disabled}
            aria-label={t("form.port")}
          />
        </div>
      </div>

      {/* Auth */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-sm">{t("form.username")}</Label>
          <Input
            value={usernameDraft}
            onChange={(e) => setUsernameDraft(e.target.value)}
            onBlur={commitUsername}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            placeholder={t("form.optionalPlaceholder")}
            disabled={disabled}
            aria-label={t("form.username")}
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm">{t("form.password")}</Label>
          <Input
            type="password"
            value={passwordDraft}
            onChange={(e) => {
              setPasswordDraft(e.target.value)
              setPasswordIntent(e.target.value ? "replace" : "keep")
            }}
            onBlur={() => void commitPassword()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            placeholder={
              credentialConfigured
                ? t("form.passwordConfiguredPlaceholder")
                : t("form.optionalPlaceholder")
            }
            disabled={disabled}
            aria-label={t("form.password")}
            autoComplete="off"
          />
          {credentialConfigured && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => void clearPassword()}
              aria-label={t("form.clearPassword")}
            >
              {t("form.clearPassword")}
            </Button>
          )}
          {credentialError && (
            <p role="alert" className="text-xs text-destructive">
              {t("form.passwordKeyringError")}
            </p>
          )}
        </div>
      </div>

      {/* WebSocket toggle */}
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("form.proxyWebsocketsLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("form.proxyWebsocketsHint")}</p>
        </div>
        <Switch
          checked={cfg.proxyWebsockets}
          onCheckedChange={(v) => persist({ proxyWebsockets: v })}
          disabled={disabled}
          aria-label={t("form.proxyWebsocketsLabel")}
        />
      </div>

      {/* Bypass list */}
      <div className="space-y-2">
        <Label className="text-sm">{t("form.bypass")}</Label>
        <p className="text-xs text-muted-foreground">{t("form.bypassHint")}</p>
        <div className="flex gap-2">
          <Input
            value={bypassDraft}
            onChange={(e) => setBypassDraft(e.target.value)}
            placeholder={/* i18n-exempt: technical domain suffix example */ ".internal"}
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void addBypass()
              }
            }}
            aria-label={t("form.bypass")}
          />
          <Button onClick={addBypass} disabled={disabled || !bypassDraft.trim()}>
            {t("form.addBypass")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {cfg.bypass.map((entry) => (
            <Badge
              key={entry}
              variant="secondary"
              className="cursor-pointer"
              onClick={() => !disabled && void removeBypass(entry)}
              role="button"
              aria-label={t("form.removeBypass", { entry })}
            >
              {entry} <span className="ml-1 text-muted-foreground">×</span>
            </Badge>
          ))}
        </div>
      </div>
    </div>
  )
}
