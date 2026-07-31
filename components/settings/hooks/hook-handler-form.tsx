"use client"

/**
 * HookHandlerForm — discriminated form for `HookHandler` (`command` | `webhook`).
 *
 * Phase 5 of the ClaudeCode 完整化 plan. Renders inside `HookGroupEditor`,
 * which owns the array of handlers in a single `HookGroup`. This form is
 * controlled — the parent passes the current value and gets `onChange` for
 * every keystroke. Validation lives in the parent's "Save" gate via the
 * exported `validateHandler`, and is echoed inline here for feedback.
 */

import { useTranslations } from "next-intl"
import { InfoIcon, Trash2Icon } from "lucide-react"
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
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { cn } from "@/lib/utils"
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

  const error = validateHandler(value)

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
          {/* Shell command surface: reuse the shared CodeMirror `LightCodeEditor`
              for syntax highlighting + soft word-wrap. It runs identically across
              all three shells (browser / Tauri / Capacitor), so no per-platform
              editor swap is needed here — Monaco would be overkill for a compact
              inline field. Gutter/search/diagnostics are off to keep it minimal. */}
          <div
            className={cn(
              "max-h-40 min-h-[3.5rem] overflow-hidden rounded-md border bg-muted/30",
              error === "commandRequired" && "border-destructive"
            )}
          >
            <LightCodeEditor
              value={value.command}
              onChange={(next) => onChange({ ...value, command: next })}
              language="shell"
              lineNumbers={false}
              search={false}
              diagnostics={false}
              statusBar={false}
              wordWrap
              fontSize={12}
              aria-label={t("commandLabel")}
              data-testid="handler-command"
            />
          </div>
          {value.command.trim() === "" ? (
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("commandHint", { example: t("commandPlaceholder") })}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <p
            className="flex items-start gap-1.5 rounded border border-dashed bg-muted/40 p-1.5 text-[0.6875rem] text-muted-foreground"
            data-testid="handler-webhook-unsupported"
          >
            <InfoIcon className="mt-px size-3 shrink-0" aria-hidden />
            <span>{t("webhookUnsupported")}</span>
          </p>
          <div className="space-y-1">
            <Label className="text-xs">{t("urlLabel")}</Label>
            <Input
              type="url"
              value={value.url}
              onChange={(e) => onChange({ ...value, url: e.target.value })}
              placeholder={t("urlPlaceholder")}
              className="text-xs"
              aria-invalid={error === "urlRequired" || error === "urlInvalid"}
              data-testid="handler-url"
            />
          </div>
          <HeadersEditor
            headers={value.headers ?? {}}
            onChange={(h) => onChange({ ...value, headers: h })}
          />
        </>
      )}

      {error ? (
        <p className="text-[0.6875rem] text-destructive" role="alert" data-testid="handler-error">
          {t(error)}
        </p>
      ) : null}

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

/**
 * Returns a stable error code (also the i18n key under `settings.hooks.handler`)
 * when a handler is not runnable, else `null`. A command needs a non-empty
 * command; a webhook needs a syntactically valid http(s) URL.
 */
export function validateHandler(
  h: HookHandler
): "commandRequired" | "urlRequired" | "urlInvalid" | null {
  if (h.type === "command") {
    return h.command.trim() === "" ? "commandRequired" : null
  }
  const url = h.url.trim()
  if (url === "") return "urlRequired"
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "urlInvalid"
  } catch {
    return "urlInvalid"
  }
  return null
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
        <p className="text-[0.6875rem] italic text-muted-foreground">{t("headersEmpty")}</p>
      ) : (
        <div className="space-y-1">
          {/* Key rows by position, not by the (mutable) header name — keying by
              name remounts the row on every keystroke into the key field and
              steals focus. Index is stable while a key is edited in place. */}
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1">
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
