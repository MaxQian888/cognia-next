"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { McpTransport } from "@cognia/agent-config-types"
import { KvEditor } from "./kv-editor"
import {
  MCP_TRANSPORT_VALUES,
  kvRowsToObject,
  objectToKvRows,
  type KvRow,
  type McpEditorInitial,
} from "./mcp-server-utils"

interface EditorProps {
  initial: McpEditorInitial
  onCancel: () => void
  onSave: (data: McpEditorInitial) => Promise<void>
}

/**
 * Create/edit form for a single MCP server. Form ⇄ JSON toggle, transport-aware
 * config sections (stdio command+args+env, http/sse url+headers). Extracted
 * verbatim from the legacy `mcp-servers-section.tsx`; the panel hosts it inside
 * a right-side Sheet.
 *
 * Note: `appsEnabled` is intentionally NOT in the save payload — the per-agent
 * chip group is the only writer, so emitting it here would race chip clicks.
 * Callers that need a default for *new* servers merge `appsEnabled` themselves.
 */
export function McpServerEditor({ initial, onCancel, onSave }: EditorProps) {
  const t = useTranslations("mcp.editor")
  const tErrors = useTranslations("mcp.editor.errors")
  const [name, setName] = useState(initial.name)
  const [transport, setTransport] = useState<McpTransport>(initial.transport)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [saving, setSaving] = useState(false)

  const [command, setCommand] = useState(
    typeof initial.config?.command === "string" ? (initial.config.command as string) : ""
  )
  const [argsText, setArgsText] = useState(
    Array.isArray(initial.config?.args)
      ? ((initial.config.args as unknown[]).filter((x) => typeof x === "string") as string[]).join(
          "\n"
        )
      : ""
  )
  const [envRows, setEnvRows] = useState<KvRow[]>(
    objectToKvRows((initial.config as Record<string, unknown>)?.env)
  )
  const [url, setUrl] = useState(
    typeof initial.config?.url === "string" ? (initial.config.url as string) : ""
  )
  const [headerRows, setHeaderRows] = useState<KvRow[]>(
    objectToKvRows((initial.config as Record<string, unknown>)?.headers)
  )

  const [showJson, setShowJson] = useState(false)
  const [configText, setConfigText] = useState("")

  const buildConfig = (): Record<string, unknown> => {
    if (transport === "stdio") {
      const args = argsText
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean)
      const env = kvRowsToObject(envRows)
      const config: Record<string, unknown> = { command }
      if (args.length > 0) config.args = args
      if (Object.keys(env).length > 0) config.env = env
      return config
    }
    const headers = kvRowsToObject(headerRows)
    const config: Record<string, unknown> = { url }
    if (Object.keys(headers).length > 0) config.headers = headers
    return config
  }

  const switchToJson = () => {
    setConfigText(JSON.stringify(buildConfig(), null, 2))
    setShowJson(true)
  }

  const switchToForm = () => {
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>
      if (transport === "stdio") {
        setCommand(typeof parsed.command === "string" ? parsed.command : "")
        setArgsText(
          Array.isArray(parsed.args)
            ? (parsed.args as unknown[])
                .filter((x): x is string => typeof x === "string")
                .join("\n")
            : ""
        )
        setEnvRows(objectToKvRows(parsed.env))
      } else {
        setUrl(typeof parsed.url === "string" ? parsed.url : "")
        setHeaderRows(objectToKvRows(parsed.headers))
      }
      setShowJson(false)
    } catch (err) {
      toast.error(
        tErrors("jsonRevertFailed", { error: err instanceof Error ? err.message : String(err) })
      )
    }
  }

  const submit = async () => {
    if (!name.trim()) {
      toast.error(tErrors("nameRequired"))
      return
    }
    let config: Record<string, unknown>
    if (showJson) {
      try {
        config = JSON.parse(configText) as Record<string, unknown>
      } catch (err) {
        toast.error(
          tErrors("invalidJson", { error: err instanceof Error ? err.message : String(err) })
        )
        return
      }
    } else {
      config = buildConfig()
      if (transport === "stdio" && !command.trim()) {
        toast.error(tErrors("commandRequired"))
        return
      }
      if (transport !== "stdio" && !url.trim()) {
        toast.error(tErrors("urlRequired"))
        return
      }
    }
    setSaving(true)
    try {
      await onSave({ name: name.trim(), transport, config, enabled })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="mcp-server-editor">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("name")}</Label>
          <Input
            placeholder={t("placeholderName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("transport")}</Label>
          <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MCP_TRANSPORT_VALUES.map((tr) => (
                <SelectItem key={tr} value={tr}>
                  {tr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("config")}</Label>
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => (showJson ? switchToForm() : switchToJson())}
        >
          {showJson ? t("showForm") : t("showJson")}
        </button>
      </div>

      {showJson ? (
        <Textarea
          rows={8}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          className="font-mono text-xs"
          spellCheck={false}
          aria-label={t("config")}
        />
      ) : transport === "stdio" ? (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("command")}
            </Label>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("placeholderCommand")}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("args")}
            </Label>
            <Textarea
              rows={4}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={t("placeholderArgs")}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <KvEditor
            label={t("env")}
            maskValues
            rows={envRows}
            onChange={setEnvRows}
            keyPlaceholder={t("placeholderEnvKey")}
            valuePlaceholder={t("placeholderEnvValue")}
          />
        </div>
      ) : (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("url")}
            </Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("placeholderUrl")}
              className="font-mono text-xs"
            />
          </div>
          <KvEditor
            label={t("headers")}
            rows={headerRows}
            onChange={setHeaderRows}
            keyPlaceholder={t("placeholderHeaderKey")}
            valuePlaceholder={t("placeholderHeaderValue")}
          />
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">{t("forwardedNote")}</p>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          {t("enabled")}
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </div>
    </div>
  )
}
