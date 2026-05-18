"use client"

// Renders `manifest.configSchema` (a JSON-Schema-shaped descriptor) into a
// shadcn-driven form. Supports the primitive types we expect plugin authors
// to use: string / number / boolean / enum (string with `enum`) / array of
// string. Persists through `setPluginConfig` so the manager picks up the
// change on next activation.
//
// Deliberately small and focused — full JSON Schema engines (draft 7+,
// nested objects, conditional sub-schemas) are out of scope for the M5C
// pass; the UI degrades to a manifest preview when an unsupported field
// shape shows up.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getPlugin, setPluginConfig } from "@/lib/db/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePluginsStore } from "@/stores/plugins"

interface SchemaField {
  type: "string" | "number" | "boolean" | "enum" | "array" | "unsupported"
  default?: unknown
  description?: string
  enumValues?: string[]
  raw: Record<string, unknown>
}

interface SchemaShape {
  fields: Record<string, SchemaField>
  unknown: boolean
}

function parseSchema(schema: unknown): SchemaShape {
  if (!schema || typeof schema !== "object") return { fields: {}, unknown: true }
  const root = schema as Record<string, unknown>
  if (root.type !== "object" || typeof root.properties !== "object") {
    return { fields: {}, unknown: true }
  }
  const properties = root.properties as Record<string, Record<string, unknown>>
  const fields: Record<string, SchemaField> = {}
  for (const [key, prop] of Object.entries(properties)) {
    if (prop && typeof prop === "object") {
      fields[key] = parseField(prop)
    }
  }
  return { fields, unknown: false }
}

function parseField(prop: Record<string, unknown>): SchemaField {
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
    return {
      type: "enum",
      default: prop.default,
      description: typeof prop.description === "string" ? prop.description : undefined,
      enumValues: prop.enum as string[],
      raw: prop,
    }
  }
  if (prop.type === "string") {
    return {
      type: "string",
      default: typeof prop.default === "string" ? prop.default : "",
      description: typeof prop.description === "string" ? prop.description : undefined,
      raw: prop,
    }
  }
  if (prop.type === "number" || prop.type === "integer") {
    return {
      type: "number",
      default: typeof prop.default === "number" ? prop.default : 0,
      description: typeof prop.description === "string" ? prop.description : undefined,
      raw: prop,
    }
  }
  if (prop.type === "boolean") {
    return {
      type: "boolean",
      default: typeof prop.default === "boolean" ? prop.default : false,
      description: typeof prop.description === "string" ? prop.description : undefined,
      raw: prop,
    }
  }
  if (
    prop.type === "array" &&
    typeof prop.items === "object" &&
    (prop.items as { type?: string })?.type === "string"
  ) {
    return {
      type: "array",
      default: Array.isArray(prop.default) ? prop.default : [],
      description: typeof prop.description === "string" ? prop.description : undefined,
      raw: prop,
    }
  }
  return { type: "unsupported", raw: prop }
}

export function PluginConfigForm() {
  const target = usePluginsStore((s) => s.configTarget)
  const close = usePluginsStore((s) => s.closeConfigure)
  const open = target !== null
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="w-[95vw] max-w-xl">
        {target ? <PluginConfigFormContent pluginId={target.pluginId} onClose={close} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PluginConfigFormContent({ pluginId, onClose }: { pluginId: string; onClose: () => void }) {
  const t = useTranslations("plugins.configForm")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])

  if (!plugin) {
    return <p className="text-sm text-muted-foreground p-4">{t("loading")}</p>
  }

  return (
    <PluginConfigFormBody key={pluginId} pluginId={pluginId} plugin={plugin} onClose={onClose} />
  )
}

function seedValues(
  fields: Record<string, SchemaField>,
  persisted: Record<string, unknown>
): Record<string, unknown> {
  const seed: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (key in persisted) seed[key] = persisted[key]
    else if (field.default !== undefined) seed[key] = field.default
  }
  return seed
}

function PluginConfigFormBody({
  pluginId,
  plugin,
  onClose,
}: {
  pluginId: string
  plugin: PluginRow
  onClose: () => void
}) {
  const t = useTranslations("plugins.configForm")
  const schema = useMemo(
    () =>
      parseSchema((plugin.manifest as { configSchema?: Record<string, unknown> })?.configSchema),
    [plugin]
  )

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    seedValues(schema.fields, plugin.config ?? {})
  )
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await setPluginConfig(pluginId, values)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  if (schema.unknown || Object.keys(schema.fields).length === 0) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{plugin.name}</DialogTitle>
          <DialogDescription>{t("noSchema")}</DialogDescription>
        </DialogHeader>
        <Card className="p-0">
          <ScrollArea className="max-h-[40vh]">
            <pre className="p-3 text-xs font-mono">
              {JSON.stringify(plugin.config ?? {}, null, 2)}
            </pre>
          </ScrollArea>
        </Card>
        <DialogFooter>
          <Button onClick={onClose}>{t("close")}</Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {plugin.name}{" "}
          <span className="text-muted-foreground text-sm font-normal">v{plugin.version}</span>
        </DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <ScrollArea className="max-h-[60vh]">
        <div className="space-y-4 pr-3">
          {Object.entries(schema.fields).map(([key, field]) => (
            <FieldRow
              key={key}
              fieldKey={key}
              field={field}
              value={values[key] ?? field.default ?? ""}
              onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
            />
          ))}
        </div>
      </ScrollArea>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}

function FieldRow({
  fieldKey,
  field,
  value,
  onChange,
}: {
  fieldKey: string
  field: SchemaField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const t = useTranslations("plugins.configForm")
  const id = `plugin-config-${fieldKey}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {fieldKey}
      </Label>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      {renderInput(field, id, value, onChange, t)}
    </div>
  )
}

function renderInput(
  field: SchemaField,
  id: string,
  value: unknown,
  onChange: (v: unknown) => void,
  t: (key: string) => string
) {
  switch (field.type) {
    case "string": {
      const long = typeof field.raw.format === "string" && field.raw.format === "textarea"
      const Comp = long ? Textarea : Input
      return (
        <Comp
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    }
    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={typeof value === "number" ? value : Number(value ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )
    case "boolean":
      return (
        <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(v === true)} />
      )
    case "enum":
      return (
        <Select value={typeof value === "string" ? value : ""} onValueChange={(v) => onChange(v)}>
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.enumValues ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "array":
      return (
        <Textarea
          id={id}
          value={Array.isArray(value) ? value.join("\n") : ""}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }
          placeholder={t("arrayPlaceholder")}
        />
      )
    default:
      return <p className="text-xs text-muted-foreground italic">{t("unsupportedField")}</p>
  }
}
