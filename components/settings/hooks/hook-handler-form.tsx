"use client"

/**
 * Capability-aware editor for every handler the selected runtime proves.
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
import type { HookHandler, HookHandlerType } from "@/lib/claude/hooks"
import { knownHookRuntimeCapabilities } from "@/lib/claude/hooks/runtime-capabilities"

const DEFAULT_HANDLER_TYPES = knownHookRuntimeCapabilities("claude").handlerTypes

interface Props {
  value: HookHandler
  onChange: (next: HookHandler) => void
  onRemove: () => void
  supportedHandlerTypes?: readonly HookHandlerType[]
}

export function emptyHandlerForType(type: HookHandlerType): HookHandler {
  switch (type) {
    case "command":
      return { type, command: "" }
    case "http":
      return { type, url: "", headers: {} }
    case "mcp_tool":
      return { type, server: "", tool: "", input: {} }
    case "prompt":
    case "agent":
      return { type, prompt: "" }
  }
}

export function HookHandlerForm({
  value,
  onChange,
  onRemove,
  supportedHandlerTypes = DEFAULT_HANDLER_TYPES,
}: Props) {
  const t = useTranslations("settings.hooks.handler")

  const setType = (type: HookHandlerType) => {
    onChange(emptyHandlerForType(type))
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
          <Select
            value={value.type === "webhook" ? "http" : value.type}
            onValueChange={(v) => setType(v as HookHandlerType)}
          >
            <SelectTrigger className="h-7 w-36 text-xs" data-testid="handler-type-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {supportedHandlerTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`types.${type}`)}
                </SelectItem>
              ))}
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
      ) : value.type === "http" || value.type === "webhook" ? (
        <>
          <p
            className="flex items-start gap-1.5 rounded border border-dashed bg-muted/40 p-1.5 text-[0.6875rem] text-muted-foreground"
            data-testid="handler-http-capability"
          >
            <InfoIcon className="mt-px size-3 shrink-0" aria-hidden />
            <span>{t("httpCapability")}</span>
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
      ) : value.type === "mcp_tool" ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("serverLabel")}</Label>
              <Input
                value={value.server}
                onChange={(e) => onChange({ ...value, server: e.target.value })}
                data-testid="handler-server"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("toolLabel")}</Label>
              <Input
                value={value.tool}
                onChange={(e) => onChange({ ...value, tool: e.target.value })}
                data-testid="handler-tool"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("inputLabel")}</Label>
            <Input
              value={JSON.stringify(value.input ?? {})}
              onChange={(e) => {
                try {
                  const input = JSON.parse(e.target.value) as Record<string, unknown>
                  onChange({ ...value, input })
                } catch {
                  // Keep the last valid structured input; validation is shown below.
                }
              }}
              className="font-mono text-xs"
              data-testid="handler-input"
            />
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <Label className="text-xs">{t("promptLabel")}</Label>
            <LightCodeEditor
              value={value.prompt}
              onChange={(prompt) => onChange({ ...value, prompt })}
              language="markdown"
              lineNumbers={false}
              search={false}
              diagnostics={false}
              statusBar={false}
              wordWrap
              fontSize={12}
              aria-label={t("promptLabel")}
              data-testid="handler-prompt"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("modelLabel")}</Label>
            <Input
              value={value.model ?? ""}
              onChange={(e) => onChange({ ...value, model: e.target.value || undefined })}
              data-testid="handler-model"
            />
          </div>
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
):
  | "commandRequired"
  | "urlRequired"
  | "urlInvalid"
  | "serverRequired"
  | "toolRequired"
  | "promptRequired"
  | null {
  if (h.type === "command") {
    return h.command.trim() === "" ? "commandRequired" : null
  }
  if (h.type === "mcp_tool") {
    if (!h.server.trim()) return "serverRequired"
    return h.tool.trim() ? null : "toolRequired"
  }
  if (h.type === "prompt" || h.type === "agent") {
    return h.prompt.trim() ? null : "promptRequired"
  }
  if (h.type !== "webhook") return null
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
