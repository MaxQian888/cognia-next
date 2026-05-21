"use client"

/**
 * Multi-select for SDK built-in tool names + user-typed extras. The component
 * does not enumerate MCP tools — those are scoped per server and we let the
 * user type names directly so there's no UI lock-in to a specific server set.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Names align with the SDK's built-in tool surface. Keep the literal strings
 * lowercase identifiers so they match what `lib/claude/build-options.ts`
 * unions into `allowedTools`.
 */
export const SDK_BUILTIN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
] as const

export interface ToolPickerProps {
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
  /** Label keys are sourced from i18n under `scheduler.tools.*`. */
  disabled?: boolean
  testId?: string
}

export function ToolPicker({ value, onChange, disabled, testId }: ToolPickerProps) {
  const t = useTranslations("scheduler")
  const selected = useMemo(() => new Set(value ?? []), [value])
  const [extra, setExtra] = useState("")

  const toggle = useCallback(
    (name: string) => {
      const next = new Set(selected)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      const arr = [...next]
      onChange(arr.length === 0 ? undefined : arr)
    },
    [selected, onChange]
  )

  const addExtra = useCallback(() => {
    const trimmed = extra.trim()
    if (!trimmed) return
    if (selected.has(trimmed)) {
      setExtra("")
      return
    }
    onChange([...selected, trimmed])
    setExtra("")
  }, [extra, selected, onChange])

  const removeExtra = useCallback(
    (name: string) => {
      const next = (value ?? []).filter((v) => v !== name)
      onChange(next.length === 0 ? undefined : next)
    },
    [value, onChange]
  )

  const customNames = (value ?? []).filter(
    (v) => !(SDK_BUILTIN_TOOLS as readonly string[]).includes(v)
  )

  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {SDK_BUILTIN_TOOLS.map((name) => (
          <label
            key={name}
            className="flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-muted/40"
            title={name}
          >
            <Checkbox
              checked={selected.has(name)}
              onCheckedChange={() => toggle(name)}
              disabled={disabled}
              data-testid={`${testId}-builtin-${name}`}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
          </label>
        ))}
      </div>

      {customNames.length > 0 && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("tools.customLabel")}</Label>
          <div className="flex flex-wrap gap-1">
            {customNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
                data-testid={`${testId}-custom-${name}`}
              >
                <span className="font-mono">{name}</span>
                <button
                  type="button"
                  onClick={() => removeExtra(name)}
                  disabled={disabled}
                  aria-label={t("tools.remove")}
                  className="rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs text-muted-foreground">{t("tools.addCustomLabel")}</Label>
          <Input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addExtra()
              }
            }}
            placeholder={t("tools.addCustomPlaceholder")}
            disabled={disabled}
            className="h-9 font-mono text-xs"
            data-testid={`${testId}-add-input`}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addExtra}
          disabled={disabled || !extra.trim()}
          data-testid={`${testId}-add-button`}
        >
          <Plus className="h-4 w-4 mr-1" />
          {t("tools.add")}
        </Button>
      </div>
    </div>
  )
}
