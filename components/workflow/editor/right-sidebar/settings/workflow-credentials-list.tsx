"use client"

/**
 * WorkflowCredentialsList — manages the workflow's credential REFERENCES
 * (id / name / optional kind). Values are never stored here: at run time the
 * orchestrator resolves a ref through the OS keyring via `ctx.resolveSecret`
 * (see `lib/workflow/runtime/secret-resolver-keyring.ts`).
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { WorkflowCredentialRef } from "@/types/workflow/visual"

export interface WorkflowCredentialsListProps {
  value: Record<string, WorkflowCredentialRef>
  onChange: (next: Record<string, WorkflowCredentialRef>) => void
}

interface Row extends WorkflowCredentialRef {
  /** The map key — defaults to `id` but kept separate so edits don't reorder. */
  mapKey: string
}

function toRows(map: Record<string, WorkflowCredentialRef>): Row[] {
  return Object.entries(map).map(([mapKey, ref]) => ({ mapKey, ...ref }))
}

function toMap(rows: Row[]): Record<string, WorkflowCredentialRef> {
  const out: Record<string, WorkflowCredentialRef> = {}
  for (const row of rows) {
    if (row.id.length === 0) continue
    out[row.id] = { id: row.id, name: row.name, kind: row.kind || undefined }
  }
  return out
}

export function WorkflowCredentialsList({ value, onChange }: WorkflowCredentialsListProps) {
  const t = useTranslations("workflowEditor.settings.credentials")
  const rows = toRows(value)
  const commit = useCallback((next: Row[]) => onChange(toMap(next)), [onChange])

  const setField = (index: number, field: keyof WorkflowCredentialRef, val: string) => {
    commit(rows.map((r, i) => (i === index ? { ...r, [field]: val } : r)))
  }
  const addRow = () => commit([...rows, { mapKey: "", id: "", name: "", kind: "" }])
  const removeRow = (index: number) => commit(rows.filter((_, i) => i !== index))

  return (
    <div className="space-y-2" data-testid="workflow-credentials-list">
      <p className="text-[11px] text-muted-foreground">{t("refOnlyNote")}</p>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t("empty")}</p> : null}
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            value={row.id}
            onChange={(e) => setField(idx, "id", e.target.value)}
            placeholder={t("idPlaceholder")}
            aria-label={t("idPlaceholder")}
            className="h-9 font-mono text-xs"
            data-testid={`wf-cred-id-${idx}`}
          />
          <Input
            value={row.name}
            onChange={(e) => setField(idx, "name", e.target.value)}
            placeholder={t("namePlaceholder")}
            aria-label={t("namePlaceholder")}
            className="h-9 text-xs"
            data-testid={`wf-cred-name-${idx}`}
          />
          <Input
            value={row.kind ?? ""}
            onChange={(e) => setField(idx, "kind", e.target.value)}
            placeholder={t("kindPlaceholder")}
            aria-label={t("kindPlaceholder")}
            className="h-9 w-28 text-xs"
            data-testid={`wf-cred-kind-${idx}`}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => removeRow(idx)}
            aria-label={t("removeAria")}
            data-testid={`wf-cred-remove-${idx}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={addRow} data-testid="wf-cred-add">
        <Plus className="mr-1 h-4 w-4" />
        {t("addButton")}
      </Button>
    </div>
  )
}
