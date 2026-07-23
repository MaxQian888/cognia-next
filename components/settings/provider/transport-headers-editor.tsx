"use client"

// Static transport-header editor (ADR-0090 Phase 1). Edits a provider's
// `customHeaders` map with inline validation through the shared transport
// header policy — blocked names (auth, hop-by-hop, Host, browser-forwarding,
// x-cognia-*) surface a reason-coded error and cannot be saved.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  checkHeader,
  type HeaderPolicyReason,
} from "@cognia/provider-types/transport-header-policy"

export interface TransportHeadersEditorProps {
  value: Record<string, string> | undefined
  onChange: (next: Record<string, string> | undefined) => void
  /** Id prefix so multiple editors can coexist in one form. */
  idPrefix?: string
}

interface DraftRow {
  name: string
  value: string
}

function rowsFromValue(value: Record<string, string> | undefined): DraftRow[] {
  return Object.entries(value ?? {}).map(([name, headerValue]) => ({ name, value: headerValue }))
}

function reasonKey(reason: HeaderPolicyReason): string {
  // Reason codes are kebab-case; i18n keys are camelCase suffixes.
  const suffix = reason.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return `transportHeadersReason_${suffix}`
}

export function TransportHeadersEditor({
  value,
  onChange,
  idPrefix = "transport-header",
}: TransportHeadersEditorProps) {
  const t = useTranslations("providers")
  const [rows, setRows] = useState<DraftRow[]>(() => rowsFromValue(value))

  const violations = useMemo(
    () =>
      rows.map((row) => {
        if (row.name.trim() === "" && row.value.trim() === "") return null
        const verdict = checkHeader(row.name, row.value, "static")
        return verdict.allowed ? null : verdict.reason
      }),
    [rows]
  )

  const commit = (nextRows: DraftRow[]) => {
    setRows(nextRows)
    const clean: Record<string, string> = {}
    for (const row of nextRows) {
      const name = row.name.trim()
      if (!name) continue
      if (!checkHeader(name, row.value, "static").allowed) continue
      clean[name] = row.value
    }
    onChange(Object.keys(clean).length > 0 ? clean : undefined)
  }

  const updateRow = (index: number, patch: Partial<DraftRow>) => {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("transportHeadersLabel")}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => commit([...rows, { name: "", value: "" }])}
          aria-label={t("transportHeadersAdd")}
        >
          <Plus className="h-4 w-4" />
          {t("transportHeadersAdd")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("transportHeadersHint")}</p>
      {rows.map((row, index) => {
        const reason = violations[index]
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input
                id={`${idPrefix}-name-${index}`}
                value={row.name}
                placeholder={t("transportHeadersNamePlaceholder")}
                aria-label={t("transportHeadersName")}
                aria-invalid={reason ? true : undefined}
                onChange={(e) => updateRow(index, { name: e.target.value })}
                className="flex-1"
              />
              <Input
                id={`${idPrefix}-value-${index}`}
                value={row.value}
                placeholder={t("transportHeadersValuePlaceholder")}
                aria-label={t("transportHeadersValue")}
                onChange={(e) => updateRow(index, { value: e.target.value })}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("transportHeadersRemove")}
                onClick={() => commit(rows.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {reason ? (
              <p role="alert" className="text-xs text-destructive">
                {t(reasonKey(reason))}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
