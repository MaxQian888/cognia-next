"use client"

// Per-account preset binding selector (v3). Lets the user pin one account to a
// specific endpoint preset from the provider's library, or fall back to the
// provider-level default. Gated on `providerSupportsPresets` below, which
// accepts registered provider identifiers, including custom and plugin providers.
//
// On change it fetches the full Account (to keep the secret bearer intact),
// rewrites `presetId`, and saves it back through the keyring transport.

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

import { getAccount, listPresets, saveAccount } from "@/lib/subscription/core/transport"
import { isTauri } from "@/lib/tauri"
import type { ProviderId, ProviderPreset } from "@/types/subscription"

/** Sentinel option value for "no explicit binding → use provider default". */
const USE_DEFAULT = "__default__"

interface AccountPresetSelectorProps {
  provider: ProviderId
  accountId: string
}

export type PresetCapableProvider = ProviderId

export function providerSupportsPresets(provider: ProviderId): provider is PresetCapableProvider {
  return /^[a-z][a-z0-9_.:-]{0,127}$/.test(provider)
}

export function AccountPresetSelector({ provider, accountId }: AccountPresetSelectorProps) {
  if (!isTauri()) return null
  return (
    <AccountPresetBinding
      key={`${provider}:${accountId}`}
      provider={provider}
      accountId={accountId}
    />
  )
}

function AccountPresetBinding({ provider, accountId }: AccountPresetSelectorProps) {
  const t = useTranslations("subscription.common.accountPreset")
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetId, setPresetId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<"loadFailed" | "saveFailed" | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [library, account] = await Promise.all([
          listPresets(provider),
          getAccount(provider, accountId),
        ])
        if (!alive) return
        setPresets(library)
        setPresetId(account?.presetId ?? null)
      } catch {
        if (alive) setError("loadFailed")
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [provider, accountId, loadAttempt])

  const onChange = async (value: string) => {
    const nextPresetId = value === USE_DEFAULT ? null : value
    setBusy(true)
    setError(null)
    try {
      const account = await getAccount(provider, accountId)
      if (!mounted.current) return
      if (!account) {
        setError("saveFailed")
        return
      }
      const next = { ...account }
      if (nextPresetId) next.presetId = nextPresetId
      else delete next.presetId
      await saveAccount(provider, next)
      if (mounted.current) setPresetId(nextPresetId)
    } catch {
      if (mounted.current) setError("saveFailed")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (loading)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t("loading")}
      </p>
    )
  if (error === "loadFailed")
    return (
      <div>
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setLoading(true)
            setError(null)
            setLoadAttempt((value) => value + 1)
          }}
        >
          {t("retry")}
        </Button>
      </div>
    )

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
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t(error)}
        </p>
      )}
    </div>
  )
}

/** Shared creation-time binding; the parent persists it with the new account. */
export function NewAccountPresetSelector({
  provider,
  value,
  onChange,
  disabled = false,
}: {
  provider: PresetCapableProvider
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
}) {
  const t = useTranslations("subscription.common.accountPreset")
  const id = useId()
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    void listPresets(provider).then(
      (library) => {
        if (alive) {
          setPresets(library)
          setFailed(false)
        }
      },
      () => {
        if (alive) setFailed(true)
      }
    )
    return () => {
      alive = false
    }
  }, [provider])

  if (failed)
    return (
      <p role="alert" className="text-xs text-destructive">
        {t("loadFailed")}
      </p>
    )
  if (presets.length === 0) return null

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("ariaLabel")}</Label>
      <NativeSelect
        id={id}
        wrapperClassName="w-full"
        disabled={disabled}
        value={value ?? USE_DEFAULT}
        onChange={(event) =>
          onChange(event.target.value === USE_DEFAULT ? null : event.target.value)
        }
      >
        <NativeSelectOption value={USE_DEFAULT}>{t("useDefault")}</NativeSelectOption>
        {presets.map((preset) => (
          <NativeSelectOption key={preset.id} value={preset.id}>
            {preset.label || preset.baseUrl}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{t("newAccountHint")}</p>
    </div>
  )
}
