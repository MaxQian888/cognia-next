"use client"

/**
 * Bound Feishu/Lark account picker for the add-source flow.
 *
 * Lists the user's configured Lark connector adapter instances (the "bound
 * Feishu accounts" — Platform Connectors owns binding + OAuth) and lets the
 * user choose which account's credentials fetch a doc. Metadata only: the
 * picker never reads the keyring. Accounts with a completed OAuth user
 * connection show the connected user's name; app-only accounts get a hint
 * that document ACLs will apply to the bot identity.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import type { LarkConnectedUser } from "@/lib/connectors/adapters/lark/oauth-handler"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export interface LarkAccountOption {
  adapterId: string
  displayName: string
  connectedUserName?: string
}

export interface LarkAccountPickerProps {
  value: string | null
  onChange: (adapterId: string | null) => void
  disabled?: boolean
}

export function LarkAccountPicker({ value, onChange, disabled }: LarkAccountPickerProps) {
  const t = useTranslations("twin.sourceUploader.lark")
  const [accounts, setAccounts] = useState<LarkAccountOption[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await listAdapterInstancesByType("lark")
      if (cancelled) return
      const enabled = rows
        .filter((row) => row.enabled)
        .map((row) => {
          const connectedUser = (row.settings as { connectedUser?: LarkConnectedUser })
            .connectedUser
          return {
            adapterId: row.id,
            displayName: row.displayName,
            connectedUserName: connectedUser?.name,
          }
        })
      setAccounts(enabled)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-select when exactly one account is bound (async load callback path
  // can't call onChange with fresh props — derive here instead).
  useEffect(() => {
    if (accounts && accounts.length === 1 && value === null) {
      onChange(accounts[0].adapterId)
    }
  }, [accounts, value, onChange])

  if (accounts === null) {
    return (
      <p className="text-muted-foreground text-xs" data-testid="twin-lark-picker-loading">
        {t("loadingAccounts")}
      </p>
    )
  }

  if (accounts.length === 0) {
    return (
      <p className="text-muted-foreground text-xs" data-testid="twin-lark-picker-empty">
        {t("noAccounts")}{" "}
        <a href="/settings?section=connections" className="text-primary underline">
          {t("goBind")}
        </a>
      </p>
    )
  }

  const selected = accounts.find((a) => a.adapterId === value)

  return (
    <div className="flex flex-col gap-1" data-testid="twin-lark-picker">
      <Label htmlFor="twin-lark-account">{t("accountLabel")}</Label>
      <Select
        value={value ?? ""}
        onValueChange={(next) => onChange(next || null)}
        disabled={disabled}
      >
        <SelectTrigger id="twin-lark-account" aria-label={t("accountLabel")}>
          <SelectValue placeholder={t("accountPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.adapterId} value={account.adapterId}>
              {account.connectedUserName
                ? `${account.displayName} · ${account.connectedUserName}`
                : account.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && !selected.connectedUserName ? (
        <p className="text-muted-foreground text-xs" data-testid="twin-lark-picker-app-only">
          {t("appOnlyHint")}
        </p>
      ) : null}
    </div>
  )
}
