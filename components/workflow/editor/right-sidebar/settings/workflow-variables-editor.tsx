"use client"

/**
 * WorkflowVariablesEditor — a key→value list for author-time workflow
 * variables, referenced in expressions as `{{ $vars.KEY }}`. Mirrors the
 * add/remove row pattern of `scheduler/payload-editors/additional-directories-list`.
 *
 * Keys must be valid identifiers (so the expression tokenizer resolves
 * `$vars.KEY`) and unique. Invalid/duplicate keys surface an inline message
 * and are not committed.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface WorkflowVariablesEditorProps {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

interface Row {
  key: string
  value: string
}

function toRows(map: Record<string, string>): Row[] {
  return Object.entries(map).map(([key, value]) => ({ key, value }))
}

function toMap(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of rows) {
    if (key.length > 0) out[key] = value
  }
  return out
}

export function WorkflowVariablesEditor({ value, onChange }: WorkflowVariablesEditorProps) {
  const t = useTranslations("workflowEditor.settings.variables")
  const rows = toRows(value)

  const commit = useCallback((next: Row[]) => onChange(toMap(next)), [onChange])

  const setKey = (index: number, key: string) => {
    const next = rows.map((r, i) => (i === index ? { ...r, key } : r))
    commit(next)
  }
  const setVal = (index: number, val: string) => {
    const next = rows.map((r, i) => (i === index ? { ...r, value: val } : r))
    commit(next)
  }
  const addRow = () => commit([...rows, { key: "", value: "" }])
  const removeRow = (index: number) => commit(rows.filter((_, i) => i !== index))

  // Per-row validation: invalid identifier or a duplicate of an earlier key.
  const keyError = (index: number): string | null => {
    const key = rows[index].key
    if (key.length === 0) return null
    if (!KEY_RE.test(key)) return t("invalidKey")
    if (rows.findIndex((r) => r.key === key) !== index) return t("duplicateKey")
    return null
  }

  return (
    <div className="space-y-2" data-testid="workflow-variables-editor">
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t("empty")}</p> : null}
      {rows.map((row, idx) => {
        const err = keyError(idx)
        return (
          <div key={idx} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input
                value={row.key}
                onChange={(e) => setKey(idx, e.target.value)}
                placeholder={t("keyPlaceholder")}
                aria-label={t("keyPlaceholder")}
                aria-invalid={err ? true : undefined}
                className="h-9 font-mono text-xs"
                data-testid={`wf-var-key-${idx}`}
              />
              <Input
                value={row.value}
                onChange={(e) => setVal(idx, e.target.value)}
                placeholder={t("valuePlaceholder")}
                aria-label={t("valuePlaceholder")}
                className="h-9 text-xs"
                data-testid={`wf-var-value-${idx}`}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => removeRow(idx)}
                aria-label={t("removeAria")}
                data-testid={`wf-var-remove-${idx}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {err ? <p className="text-[11px] text-destructive">{err}</p> : null}
          </div>
        )
      })}
      <Button type="button" size="sm" variant="outline" onClick={addRow} data-testid="wf-var-add">
        <Plus className="mr-1 h-4 w-4" />
        {t("addButton")}
      </Button>
    </div>
  )
}
