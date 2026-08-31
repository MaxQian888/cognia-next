"use client"

/**
 * A structured row editor over a param that is stored as raw JSON.
 *
 * Two inspector fields, an agent team's members and a plan's steps, shipped as
 * bare `<Textarea>`s holding hand-written JSON. Both describe a list of small
 * records whose ids come from registries the editor can already read, so
 * authoring them meant typing a character id from memory into a JSON array and
 * finding out at run time whether it was right.
 *
 * The escape hatch stays: some authors paste a whole array, and an expression
 * is legal in these fields. Toggling to JSON shows exactly what is stored.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Braces, ListChecks, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface StructuredJsonFieldProps<T> {
  id: string
  /** Parsed rows. Empty when the raw text is not a JSON array. */
  rows: T[]
  /** The raw text actually stored on the node. */
  raw: string
  /** Write both shapes at once, so the two never disagree. */
  onChange: (rows: T[], raw: string) => void
  /** A blank row, appended by the add button. */
  makeRow: () => T
  /** Render one row's controls. */
  renderRow: (row: T, index: number, patch: (next: Partial<T>) => void) => ReactNode
  /** Shown in place of the rows when the list is empty. */
  emptyHint?: string
  addLabel: string
  /** True when the stored text is not a JSON array, which pins JSON mode on. */
  jsonOnly?: boolean
}

export function StructuredJsonField<T>({
  id,
  rows,
  raw,
  onChange,
  makeRow,
  renderRow,
  emptyHint,
  addLabel,
  jsonOnly = false,
}: StructuredJsonFieldProps<T>) {
  const t = useTranslations("workflows.forms.structured")
  const [jsonMode, setJsonMode] = useState(jsonOnly)
  const showJson = jsonOnly || jsonMode

  const write = (next: T[]) => onChange(next, JSON.stringify(next, null, 2))

  if (showJson) {
    return (
      <div className="space-y-1.5">
        <Textarea
          id={id}
          value={raw}
          onChange={(e) => {
            const text = e.target.value
            let parsed: T[] = []
            try {
              const value: unknown = JSON.parse(text)
              if (Array.isArray(value)) parsed = value as T[]
            } catch {
              // Keep the text the author is mid-way through typing. `rows` just
              // stays at its last valid value until the JSON parses again.
              parsed = rows
            }
            onChange(parsed, text)
          }}
          rows={6}
          className="font-mono text-xs"
          data-testid={`${id}-json`}
        />
        {jsonOnly ? (
          <p className="text-xs text-muted-foreground">{t("jsonOnly")}</p>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs text-muted-foreground"
            onClick={() => setJsonMode(false)}
            data-testid={`${id}-use-rows`}
          >
            <ListChecks className="mr-1 size-3" aria-hidden="true" />
            {t("useRows")}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-1.5" data-testid={`${id}-rows`}>
      {rows.length === 0 && emptyHint ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-1.5" data-testid={`${id}-row-${index}`}>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {renderRow(row, index, (next) =>
              write(rows.map((r, i) => (i === index ? { ...r, ...next } : r)))
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => write(rows.filter((_, i) => i !== index))}
            aria-label={t("removeRow")}
            data-testid={`${id}-remove-${index}`}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => write([...rows, makeRow()])}
          data-testid={`${id}-add`}
        >
          <Plus className="mr-1 size-3" aria-hidden="true" />
          {addLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-1 text-xs text-muted-foreground"
          onClick={() => setJsonMode(true)}
          data-testid={`${id}-use-json`}
        >
          <Braces className="mr-1 size-3" aria-hidden="true" />
          {t("useJson")}
        </Button>
      </div>
    </div>
  )
}

/** Parse a raw JSON-array param into rows, tolerating an in-progress edit. */
export function parseJsonRows<T>(raw: string): { rows: T[]; jsonOnly: boolean } {
  const text = raw.trim()
  if (!text) return { rows: [], jsonOnly: false }
  try {
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value)) return { rows: value as T[], jsonOnly: false }
  } catch {
    // Not JSON at all: an expression, or a half-typed array. Either way the row
    // editor would silently discard it, so JSON mode is pinned on.
    return { rows: [], jsonOnly: true }
  }
  return { rows: [], jsonOnly: true }
}
