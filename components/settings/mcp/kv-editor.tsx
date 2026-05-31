"use client"

import { PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { KvRow } from "./mcp-server-utils"

interface KvEditorProps {
  /** Pre-translated section label (e.g. "Environment variables"). */
  label: string
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}

/**
 * Dynamic key/value row editor used for stdio `env` and http/sse `headers`.
 * Extracted from the legacy `mcp-servers-section.tsx` so the editor sheet can
 * reuse it; the only behavioral change is i18n for its add / empty / remove
 * affordances.
 */
export function KvEditor({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: KvEditorProps) {
  const t = useTranslations("mcp.editor")
  const updateRow = (index: number, patch: Partial<KvRow>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index))
  }
  const addRow = () => {
    onChange([...rows, { key: "", value: "" }])
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={addRow}
        >
          <PlusIcon className="mr-1 size-3" />
          {t("kvAdd")}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[10px] italic text-muted-foreground">{t("kvEmpty")}</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                placeholder={keyPlaceholder}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Input
                value={row.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                placeholder={valuePlaceholder}
                className="h-7 flex-[2] font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => removeRow(i)}
                aria-label={t("kvRemove")}
              >
                <Trash2Icon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
