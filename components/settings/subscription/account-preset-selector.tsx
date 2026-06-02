"use client"

// Per-account preset binding selector (v3). Lets the user pin one account to a
// specific endpoint preset from the provider's library, or fall back to the
// provider-level default. Only meaningful for providers that support presets
// (anthropic, codex) — OpenCode manages endpoints in its own auth.json.
//
// On change it fetches the full Account (to keep the secret bearer intact),
// rewrites `presetId`, and saves it back through the keyring transport.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { getAccount, listPresets, saveAccount } from "@/lib/subscription/core/transport"
import { isTauri } from "@/lib/tauri"
import type { ProviderId, ProviderPreset } from "@/types/subscription"

/** Sentinel option value for "no explicit binding → use provider default". */
const USE_DEFAULT = "__default__"

export type PresetCapableProvider = Extract<ProviderId, "anthropic" | "codex">

export function providerSupportsPresets(provider: ProviderId): provider is PresetCapableProvider {
  return provider === "anthropic" || provider === "codex"
}

export interface AccountPresetSelectorProps {
  provider: PresetCapableProvider
  accountId: string
}

export function AccountPresetSelector({ provider, accountId }: AccountPresetSelectorProps) {
  const t = useTranslations("subscription.common.accountPreset")
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetId, setPresetId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!isTauri()) return
      const [library, account] = await Promise.all([
        listPresets(provider),
        getAccount(provider, accountId),
      ])
      if (!alive) return
      setPresets(library)
      setPresetId(account?.presetId ?? null)
    })()
    return () => {
      alive = false
    }
  }, [provider, accountId])

  const onChange = async (value: string) => {
    const nextPresetId = value === USE_DEFAULT ? null : value
    setBusy(true)
    try {
      const account = await getAccount(provider, accountId)
      if (!account) return
      const next = { ...account }
      if (nextPresetId) next.presetId = nextPresetId
      else delete next.presetId
      await saveAccount(provider, next)
      setPresetId(nextPresetId)
    } finally {
      setBusy(false)
    }
  }

  // Nothing to bind to — hide the control until a preset exists.
  if (presets.length === 0) return null

  return (
    <div className="mt-1.5">
      <Select
        value={presetId ?? USE_DEFAULT}
        onValueChange={(v) => void onChange(v)}
        disabled={busy}
      >
        <SelectTrigger className="h-7 w-full text-xs" aria-label={t("ariaLabel")} size="sm">
          <SelectValue placeholder={t("useDefault")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={USE_DEFAULT} className="text-xs">
            {t("useDefault")}
          </SelectItem>
          {presets.map((preset) => (
            <SelectItem key={preset.id} value={preset.id} className="text-xs">
              {preset.label || preset.baseUrl}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
