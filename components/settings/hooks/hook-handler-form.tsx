"use client"

/**
 * HookHandlerForm — discriminated form for `HookHandler` (`command` | `webhook`).
 *
 * Phase 5 of the ClaudeCode 完整化 plan. Renders inside `HookGroupEditor`,
 * which owns the array of handlers in a single `HookGroup`. This form is
 * controlled — the parent passes the current value and gets `onChange` for
 * every keystroke. Validation lives in the parent's "Save" gate.
 */

import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { HookHandler } from "@/lib/claude/hooks"

interface Props {
  value: HookHandler
  onChange: (next: HookHandler) => void
  onRemove: () => void
}

export function HookHandlerForm({ value, onChange, onRemove }: Props) {
  const t = useTranslations("settings.hooks.handler")

  const setType = (type: HookHandler["type"]) => {
    if (type === "command") {
      onChange({ type: "command", command: "", timeout: undefined })
    } else {
      onChange({ type: "webhook", url: "", headers: {}, timeout: undefined })
    }
  }

  return (
    <div
      className="space-y-2 rounded-md border bg-muted/30 p-3"
      data-testid="hook-handler-form"
      data-handler-type={value.type}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">{t("typeLabel")}</Label>
          <Select value={value.type} onValueChange={(v) => setType(v as HookHandler["type"])}>
            <SelectTrigger className="h-7 w-32 text-xs" data-testid="handler-type-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="command">{t("typeCommand")}</SelectItem>
              <SelectItem value="webhook">{t("typeWebhook")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive"
          onClick={onRemove}
          aria-label={t("removeAria")}
          data-testid="handler-remove"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      {value.type === "command" ? (
        <div className="space-y-1">
          <Label className="text-xs">{t("commandLabel")}</Label>
          <Textarea
            rows={2}
            value={value.command}
            onChange={(e) => onChange({ ...value, command: e.target.value })}
            placeholder={t("commandPlaceholder")}
            className="font-mono text-xs"
            data-testid="handler-command"
          />
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <Label className="text-xs">{t("urlLabel")}</Label>
            <Input
              type="url"
              value={value.url}
              onChange={(e) => onChange({ ...value, url: e.target.value })}
              placeholder={t("urlPlaceholder")}
              className="text-xs"
              data-testid="handler-url"
            />
          </div>
          <HeadersEditor
            headers={value.headers ?? {}}
            onChange={(h) => onChange({ ...value, headers: h })}
          />
        </>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{t("timeoutLabel")}</Label>
        <Input
          type="number"
          min={0}
          value={value.timeout ?? ""}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === "" ? undefined : Number(raw)
            onChange({ ...value, timeout: Number.isFinite(n) ? n : undefined })
          }}
          placeholder={t("timeoutPlaceholder")}
          className="h-7 w-32 text-xs"
          data-testid="handler-timeout"
        />
      </div>
    </div>
  )
}

interface HeadersProps {
  headers: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

function HeadersEditor({ headers, onChange }: HeadersProps) {
  const t = useTranslations("settings.hooks.handler")
  const entries = Object.entries(headers)
  const addRow = () => onChange({ ...headers, "": "" })
  const update = (key: string, k: string, v: string) => {
    const next: Record<string, string> = {}
    for (const [ek, ev] of Object.entries(headers)) {
      if (ek === key) next[k] = v
      else next[ek] = ev
    }
    onChange(next)
  }
  const remove = (key: string) => {
    const next = { ...headers }
    delete next[key]
    onChange(next)
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("headersLabel")}</Label>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-xs"
          onClick={addRow}
          data-testid="handler-headers-add"
        >
          {t("headersAdd")}
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{t("headersEmpty")}</p>
      ) : (
        <div className="space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-1">
              <Input
                value={k}
                onChange={(e) => update(k, e.target.value, v)}
                placeholder={t("headerKeyPlaceholder")}
                className="h-7 text-xs"
                data-testid="handler-header-key"
              />
              <Input
                value={v}
                onChange={(e) => update(k, k, e.target.value)}
                placeholder={t("headerValuePlaceholder")}
                className="h-7 text-xs"
                data-testid="handler-header-value"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive"
                onClick={() => remove(k)}
                aria-label={t("headerRemoveAria")}
                data-testid="handler-header-remove"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
