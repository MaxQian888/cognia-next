"use client"

// Renders `manifest.configSchema` (a JSON-Schema-shaped descriptor) into a
// shadcn-driven form. Supports:
//   - primitives: string / number / integer / boolean
//   - enum (string with `enum`)
//   - array of string  (newline-separated)
//   - nested object    (`type: "object"`, recursively rendered)
//   - array of object  (`type: "array"`, `items.type === "object"`)
//   - oneOf / anyOf    (radio-switched sub-form per variant)
//   - field validation: pattern + patternMessage, minLength / maxLength,
//                       min / max, format: email | url | uri
//
// Persists through `setPluginConfig` so the manager picks up the change
// on next activation. Schema shapes the parser can't recognise still
// degrade to a manifest preview (the existing fallback path).

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PluginExtensionBoundary } from "@/components/plugins/plugin-extension-slot"
import {
  loadConfigComponent,
  type ConfigComponent,
} from "@/lib/plugin/bridge/config-component-bridge"
import type { PluginManifest } from "@/types/plugin/plugin"
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

/**
 * Best-effort config-change fan-out (JS onConfigChange hook + python host
 * push). Persisting via setPluginConfig stays the source of truth — a
 * missing/uninitialized manager (web mode, tests) must never fail the save.
 */
async function notifyConfigChanged(pluginId: string, config: Record<string, unknown>) {
  try {
    const { getPluginManager } = await import("@/lib/plugin/core/manager")
    await getPluginManager().notifyPluginConfigChanged(pluginId, config)
  } catch {
    // Manager not initialized — config still applies on next plugin load.
  }
}

type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "objectArray"
  | "oneOf"
  | "unsupported"

interface FieldValidator {
  pattern?: string
  patternMessage?: string
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
  format?: "email" | "url" | "uri"
}

interface OneOfVariant {
  label: string
  fields: Record<string, SchemaField>
}

interface SchemaField {
  type: FieldType
  default?: unknown
  description?: string
  enumValues?: string[]
  /** Populated when `type === "object"` or `type === "objectArray"`. */
  children?: Record<string, SchemaField>
  /** Populated when `type === "oneOf"`. */
  variants?: OneOfVariant[]
  validators?: FieldValidator
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
  return { fields: parseObjectProperties(root), unknown: false }
}

function parseValidators(prop: Record<string, unknown>): FieldValidator | undefined {
  const v: FieldValidator = {}
  if (typeof prop.pattern === "string") v.pattern = prop.pattern
  if (typeof prop.patternMessage === "string") v.patternMessage = prop.patternMessage
  if (typeof prop.minLength === "number") v.minLength = prop.minLength
  if (typeof prop.maxLength === "number") v.maxLength = prop.maxLength
  if (typeof prop.minimum === "number") v.min = prop.minimum
  if (typeof prop.min === "number") v.min = prop.min
  if (typeof prop.maximum === "number") v.max = prop.maximum
  if (typeof prop.max === "number") v.max = prop.max
  if (prop.format === "email" || prop.format === "url" || prop.format === "uri") {
    v.format = prop.format
  }
  return Object.keys(v).length > 0 ? v : undefined
}

function describe(prop: Record<string, unknown>): string | undefined {
  if (typeof prop.description === "string") return prop.description
  // markdownDescription is rendered as plain text here (untrusted plugin input
  // is not passed through a markdown renderer); it is preferable to losing it.
  if (typeof prop.markdownDescription === "string") return prop.markdownDescription
  return undefined
}

/**
 * Field entries sorted by the VS Code-style `order` (ascending; entries without
 * an `order` sort last). Array.sort is stable, so declaration order is the
 * tiebreaker.
 */
function orderedFieldEntries(fields: Record<string, SchemaField>): [string, SchemaField][] {
  return Object.entries(fields).sort((a, b) => {
    const oa =
      typeof a[1].raw.order === "number" ? (a[1].raw.order as number) : Number.POSITIVE_INFINITY
    const ob =
      typeof b[1].raw.order === "number" ? (b[1].raw.order as number) : Number.POSITIVE_INFINITY
    return oa - ob
  })
}

function parseObjectProperties(schema: Record<string, unknown>): Record<string, SchemaField> {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (!props) return {}
  const fields: Record<string, SchemaField> = {}
  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === "object") {
      fields[key] = parseField(value)
    }
  }
  return fields
}

function parseOneOfVariants(variantsRaw: unknown): OneOfVariant[] | undefined {
  if (!Array.isArray(variantsRaw)) return undefined
  const variants: OneOfVariant[] = []
  for (let i = 0; i < variantsRaw.length; i++) {
    const v = variantsRaw[i]
    if (!v || typeof v !== "object") continue
    const obj = v as Record<string, unknown>
    if (obj.type !== "object") continue
    const titleRaw = obj.title ?? obj.label
    const label = typeof titleRaw === "string" ? titleRaw : `variant_${i + 1}`
    variants.push({ label, fields: parseObjectProperties(obj) })
  }
  return variants.length > 0 ? variants : undefined
}

function parseField(prop: Record<string, unknown>): SchemaField {
  // oneOf / anyOf comes first — a `{ type: "object", oneOf: [...] }`
  // schema is meaningful as a oneOf, not as a plain object.
  const oneOfRaw = prop.oneOf ?? prop.anyOf
  if (Array.isArray(oneOfRaw)) {
    const variants = parseOneOfVariants(oneOfRaw)
    if (variants) {
      return {
        type: "oneOf",
        description: describe(prop),
        variants,
        raw: prop,
      }
    }
  }
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
    return {
      type: "enum",
      default: prop.default,
      description: describe(prop),
      enumValues: prop.enum as string[],
      validators: parseValidators(prop),
      raw: prop,
    }
  }
  if (prop.type === "string") {
    return {
      type: "string",
      default: typeof prop.default === "string" ? prop.default : "",
      description: describe(prop),
      validators: parseValidators(prop),
      raw: prop,
    }
  }
  if (prop.type === "number" || prop.type === "integer") {
    return {
      type: "number",
      default: typeof prop.default === "number" ? prop.default : 0,
      description: describe(prop),
      validators: parseValidators(prop),
      raw: prop,
    }
  }
  if (prop.type === "boolean") {
    return {
      type: "boolean",
      default: typeof prop.default === "boolean" ? prop.default : false,
      description: describe(prop),
      raw: prop,
    }
  }
  if (prop.type === "object" && typeof prop.properties === "object") {
    return {
      type: "object",
      default: typeof prop.default === "object" && prop.default !== null ? prop.default : {},
      description: describe(prop),
      children: parseObjectProperties(prop),
      raw: prop,
    }
  }
  if (prop.type === "array") {
    const items = prop.items as Record<string, unknown> | undefined
    if (items?.type === "string") {
      return {
        type: "array",
        default: Array.isArray(prop.default) ? prop.default : [],
        description: describe(prop),
        validators: parseValidators(prop),
        raw: prop,
      }
    }
    if (items?.type === "object" && typeof items.properties === "object") {
      return {
        type: "objectArray",
        default: Array.isArray(prop.default) ? prop.default : [],
        description: describe(prop),
        children: parseObjectProperties(items),
        raw: prop,
      }
    }
  }
  return { type: "unsupported", raw: prop }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime validation
// ─────────────────────────────────────────────────────────────────────────────

const FORMAT_PATTERNS: Record<NonNullable<FieldValidator["format"]>, RegExp> = {
  // Pragmatic — these don't try to be RFC-perfect; they catch obvious
  // typos and let the plugin do real verification server-side.
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^https?:\/\/[^\s]+$/i,
  uri: /^[a-z][a-z0-9+.-]*:[^\s]+$/i,
}

/**
 * Translator for the `plugins.configForm` namespace. Validation messages are
 * user-facing, so they're produced through next-intl (`validation.*` keys)
 * rather than hard-coded English. A plugin-supplied `patternMessage` is the
 * one exception — the plugin owns that string, so it's surfaced verbatim.
 */
type ConfigFormTranslate = (key: string, values?: Record<string, string | number>) => string

function validateField(field: SchemaField, value: unknown, t: ConfigFormTranslate): string | null {
  const v = field.validators
  if (!v) return null
  if (field.type === "string" || field.type === "enum") {
    if (typeof value !== "string") return null
    if (v.minLength !== undefined && value.length < v.minLength) {
      return t("validation.minLength", { min: v.minLength })
    }
    if (v.maxLength !== undefined && value.length > v.maxLength) {
      return t("validation.maxLength", { max: v.maxLength })
    }
    if (v.pattern) {
      try {
        if (!new RegExp(v.pattern).test(value)) {
          return v.patternMessage ?? t("validation.pattern", { pattern: v.pattern })
        }
      } catch {
        // Bad regex from the manifest — skip silently rather than crash.
      }
    }
    if (v.format && !FORMAT_PATTERNS[v.format].test(value)) {
      return t("validation.format", { format: v.format })
    }
  }
  if (field.type === "number") {
    const n = typeof value === "number" ? value : Number(value)
    if (Number.isNaN(n)) return t("validation.notNumber")
    if (v.min !== undefined && n < v.min) return t("validation.min", { min: v.min })
    if (v.max !== undefined && n > v.max) return t("validation.max", { max: v.max })
  }
  if (field.type === "array") {
    if (Array.isArray(value)) {
      if (v.minLength !== undefined && value.length < v.minLength) {
        return t("validation.minItems", { min: v.minLength })
      }
      if (v.maxLength !== undefined && value.length > v.maxLength) {
        return t("validation.maxItems", { max: v.maxLength })
      }
    }
  }
  return null
}

/**
 * Recursively collect per-field error messages so the form can disable
 * Save and surface inline messages. Returns a flat path → message map.
 */
function collectErrors(
  fields: Record<string, SchemaField>,
  values: Record<string, unknown>,
  t: ConfigFormTranslate,
  pathPrefix = ""
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, field] of Object.entries(fields)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key
    const value = values[key]
    if (field.type === "object" && field.children) {
      Object.assign(
        out,
        collectErrors(field.children, (value as Record<string, unknown>) ?? {}, t, path)
      )
      continue
    }
    if (field.type === "objectArray" && field.children && Array.isArray(value)) {
      value.forEach((row, idx) => {
        Object.assign(
          out,
          collectErrors(
            field.children!,
            (row as Record<string, unknown>) ?? {},
            t,
            `${path}[${idx}]`
          )
        )
      })
      continue
    }
    const err = validateField(field, value, t)
    if (err) out[path] = err
  }
  return out
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

export function PluginConfigFormContent({
  pluginId,
  onClose,
  variant = "modal",
}: {
  pluginId: string
  onClose: () => void
  variant?: PluginConfigFormVariant
}) {
  const t = useTranslations("plugins.configForm")
  const plugin = useLiveQuery(() => getPlugin(pluginId), [pluginId])

  if (!plugin) {
    return <p className="text-sm text-muted-foreground p-4">{t("loading")}</p>
  }

  return (
    <PluginConfigFormBody
      key={pluginId}
      pluginId={pluginId}
      plugin={plugin}
      onClose={onClose}
      variant={variant}
    />
  )
}

function seedValues(
  fields: Record<string, SchemaField>,
  persisted: Record<string, unknown>
): Record<string, unknown> {
  const seed: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (key in persisted) {
      // Recursively merge nested objects so adding a new manifest field
      // doesn't wipe out unrelated user values.
      if (field.type === "object" && field.children) {
        seed[key] = seedValues(field.children, (persisted[key] as Record<string, unknown>) ?? {})
      } else {
        seed[key] = persisted[key]
      }
    } else if (field.type === "object" && field.children) {
      seed[key] = seedValues(field.children, {})
    } else if (field.type === "objectArray") {
      seed[key] = Array.isArray(field.default) ? field.default : []
    } else if (field.default !== undefined) {
      seed[key] = field.default
    }
  }
  return seed
}

export type PluginConfigFormVariant = "modal" | "inline"

/**
 * Form body for a plugin's `manifest.configSchema`.
 *
 * The same body is rendered in two contexts:
 *
 *   - **modal** — wrapped in `<Dialog>` by `PluginConfigForm`; uses Dialog
 *     primitives (`DialogHeader` / `DialogFooter`) so the modal chrome lines
 *     up with the rest of the panel's dialog hosts.
 *   - **inline** — embedded inside the right-pane detail's Configure
 *     sub-tab (`components/plugins/detail/plugin-detail-configure.tsx`).
 *     Replaces Dialog primitives with plain headings so the form blends
 *     into the surrounding pane instead of looking like a misplaced
 *     dialog. `onClose` is still wired (used as "save completed"
 *     callback) but no longer closes a host.
 *
 * Both variants share schema parsing, validation, default-seeding,
 * setPluginConfig persistence, and the saving/error state machine — only
 * the surrounding chrome differs.
 */
export function PluginConfigFormBody(props: {
  pluginId: string
  plugin: PluginRow
  onClose: () => void
  variant?: PluginConfigFormVariant
}) {
  // A plugin may ship its own React settings UI via `manifest.configComponent`
  // (ADR-0026 §3 §B). When declared, render it instead of the generic
  // schema-driven form; the custom component owns its own save UI. A failed
  // import or a render crash falls back to the schema form (see
  // `CustomConfigBody`).
  const custom = (props.plugin.manifest as { configComponent?: { entry: string; export: string } })
    ?.configComponent
  if (custom) {
    return <CustomConfigBody {...props} />
  }
  return <SchemaConfigBody {...props} />
}

function SchemaConfigBody({
  pluginId,
  plugin,
  onClose,
  variant = "modal",
}: {
  pluginId: string
  plugin: PluginRow
  onClose: () => void
  variant?: PluginConfigFormVariant
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
  const errors = useMemo(() => collectErrors(schema.fields, values, t), [schema.fields, values, t])
  const hasErrors = Object.keys(errors).length > 0

  const handleSave = async () => {
    if (hasErrors) return
    setSaving(true)
    try {
      await setPluginConfig(pluginId, values)
      await notifyConfigChanged(pluginId, values)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const Header = variant === "modal" ? ModalHeader : InlineHeader
  const Footer = variant === "modal" ? ModalFooter : InlineFooter

  if (schema.unknown || Object.keys(schema.fields).length === 0) {
    return (
      <>
        <Header title={plugin.name} description={t("noSchema")} version={null} />
        <Card className="p-0">
          <ScrollArea className="max-h-[40vh]">
            <pre className="p-3 text-xs font-mono">
              {JSON.stringify(plugin.config ?? {}, null, 2)}
            </pre>
          </ScrollArea>
        </Card>
        <Footer>
          <Button onClick={onClose}>{t("close")}</Button>
        </Footer>
      </>
    )
  }

  return (
    <>
      <Header title={plugin.name} version={plugin.version} description={t("description")} />

      <ScrollArea className="max-h-[60vh]">
        <div className="space-y-4 pr-3">
          {orderedFieldEntries(schema.fields).map(([key, field]) => (
            <FieldRow
              key={key}
              fieldKey={key}
              fieldPath={key}
              field={field}
              value={values[key] ?? field.default ?? ""}
              errors={errors}
              onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
            />
          ))}
        </div>
      </ScrollArea>

      <Footer>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button onClick={handleSave} disabled={saving || hasErrors}>
          {saving ? t("saving") : t("save")}
        </Button>
      </Footer>
    </>
  )
}

type CustomLoadState =
  | { status: "loading" }
  | { status: "ready"; Component: ConfigComponent }
  | { status: "fallback" }

/**
 * Renders a plugin's `manifest.configComponent` (ADR-0026 §3 §B).
 *
 * The component is resolved lazily through the plugin manager's proven
 * 3-strategy importer (`importPluginEntry`) — the same resolver the
 * module-bridge loop uses — so Tauri asset-protocol paths load correctly.
 * The bridge caches the resolved component per pluginId.
 *
 * States: `loading` → header + spinner text; `ready` → header + the custom
 * component wrapped in the shared `PluginExtensionBoundary` (a render crash
 * records a `plugin.silent-failure` diagnostic and collapses to nothing,
 * never taking down the panel); `fallback` → the generic `SchemaConfigBody`
 * (load returned null: no component, or the import errored).
 */
function CustomConfigBody({
  pluginId,
  plugin,
  onClose,
  variant = "modal",
}: {
  pluginId: string
  plugin: PluginRow
  onClose: () => void
  variant?: PluginConfigFormVariant
}) {
  const t = useTranslations("plugins.configForm")
  const [state, setState] = useState<CustomLoadState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        const manager = getPluginManager()
        const Component = await loadConfigComponent(
          plugin.manifest as unknown as PluginManifest,
          plugin.path ?? "",
          { importer: (entry) => manager.importPluginEntry(entry) }
        )
        if (cancelled) return
        setState(Component ? { status: "ready", Component } : { status: "fallback" })
      } catch {
        if (!cancelled) setState({ status: "fallback" })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId, plugin])

  const handleSave = useCallback(
    async (next: Record<string, unknown>) => {
      await setPluginConfig(pluginId, next)
      await notifyConfigChanged(pluginId, next)
      onClose()
    },
    [pluginId, onClose]
  )

  if (state.status === "fallback") {
    return (
      <SchemaConfigBody pluginId={pluginId} plugin={plugin} onClose={onClose} variant={variant} />
    )
  }

  const Header = variant === "modal" ? ModalHeader : InlineHeader

  if (state.status === "loading") {
    return (
      <>
        <Header title={plugin.name} version={plugin.version} description={t("description")} />
        <p className="text-sm text-muted-foreground p-4">{t("loadingComponent")}</p>
      </>
    )
  }

  const { Component } = state
  return (
    <>
      <Header title={plugin.name} version={plugin.version} description={t("description")} />
      <PluginExtensionBoundary pluginId={pluginId} extensionId={`${pluginId}:configComponent`}>
        <Component config={plugin.config ?? {}} onSave={handleSave} pluginId={pluginId} />
      </PluginExtensionBoundary>
    </>
  )
}

interface HeaderProps {
  title: string
  version: string | null
  description: string
}

function ModalHeader({ title, version, description }: HeaderProps) {
  return (
    <DialogHeader>
      <DialogTitle>
        {title}
        {version ? (
          <>
            {" "}
            <span className="text-muted-foreground text-sm font-normal">v{version}</span>
          </>
        ) : null}
      </DialogTitle>
      <DialogDescription>{description}</DialogDescription>
    </DialogHeader>
  )
}

function InlineHeader({ title, version, description }: HeaderProps) {
  return (
    <header className="space-y-1 pb-2 border-b">
      <h2 className="text-base font-semibold">
        {title}
        {version ? (
          <>
            {" "}
            <span className="text-muted-foreground text-sm font-normal">v{version}</span>
          </>
        ) : null}
      </h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </header>
  )
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <DialogFooter>{children}</DialogFooter>
}

function InlineFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 pt-2 border-t">{children}</div>
}

function FieldRow({
  fieldKey,
  fieldPath,
  field,
  value,
  errors,
  onChange,
}: {
  fieldKey: string
  fieldPath: string
  field: SchemaField
  value: unknown
  errors: Record<string, string>
  onChange: (v: unknown) => void
}) {
  const t = useTranslations("plugins.configForm")
  const id = `plugin-config-${fieldPath.replace(/[.[\]]/g, "_")}`
  const error = errors[fieldPath]
  const title = typeof field.raw.title === "string" ? field.raw.title : fieldKey
  const deprecation =
    typeof field.raw.deprecationMessage === "string" ? field.raw.deprecationMessage : undefined
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {title}
      </Label>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      {deprecation && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400">
          {t("deprecated")}: {deprecation}
        </p>
      )}
      {renderInput({ field, fieldPath, id, value, errors, onChange, t })}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  )
}

interface RenderArgs {
  field: SchemaField
  fieldPath: string
  id: string
  value: unknown
  errors: Record<string, string>
  onChange: (v: unknown) => void
  t: (key: string) => string
}

function renderInput(args: RenderArgs) {
  const { field, fieldPath, id, value, errors, onChange, t } = args
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
            {(field.enumValues ?? []).map((opt, i) => {
              const descs = field.raw.enumDescriptions
              const desc =
                Array.isArray(descs) && typeof descs[i] === "string"
                  ? (descs[i] as string)
                  : undefined
              return (
                <SelectItem key={opt} value={opt}>
                  {desc ? (
                    <span className="flex flex-col">
                      <span>{opt}</span>
                      <span className="text-[10px] text-muted-foreground">{desc}</span>
                    </span>
                  ) : (
                    opt
                  )}
                </SelectItem>
              )
            })}
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
    case "object":
      return (
        <ObjectGroup
          field={field}
          fieldPath={fieldPath}
          value={(value as Record<string, unknown>) ?? {}}
          errors={errors}
          onChange={onChange}
        />
      )
    case "objectArray":
      return (
        <ObjectArray
          field={field}
          fieldPath={fieldPath}
          value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
          errors={errors}
          onChange={onChange}
          t={t}
        />
      )
    case "oneOf":
      return (
        <OneOfGroup
          field={field}
          fieldPath={fieldPath}
          value={(value as Record<string, unknown>) ?? {}}
          errors={errors}
          onChange={onChange}
          t={t}
        />
      )
    default:
      return <p className="text-xs text-muted-foreground italic">{t("unsupportedField")}</p>
  }
}

function ObjectGroup({
  field,
  fieldPath,
  value,
  errors,
  onChange,
}: {
  field: SchemaField
  fieldPath: string
  value: Record<string, unknown>
  errors: Record<string, string>
  onChange: (v: unknown) => void
}) {
  if (!field.children) return null
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-3">
      {Object.entries(field.children).map(([childKey, childField]) => (
        <FieldRow
          key={childKey}
          fieldKey={childKey}
          fieldPath={`${fieldPath}.${childKey}`}
          field={childField}
          value={value[childKey] ?? childField.default ?? ""}
          errors={errors}
          onChange={(v) => onChange({ ...value, [childKey]: v })}
        />
      ))}
    </div>
  )
}

function ObjectArray({
  field,
  fieldPath,
  value,
  errors,
  onChange,
  t,
}: {
  field: SchemaField
  fieldPath: string
  value: Record<string, unknown>[]
  errors: Record<string, string>
  onChange: (v: unknown) => void
  t: (key: string) => string
}) {
  if (!field.children) return null
  const emptyRow = (): Record<string, unknown> =>
    seedValues(field.children!, {}) as Record<string, unknown>
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic">{t("emptyArray")}</p>
      )}
      {value.map((row, idx) => (
        <div
          key={idx}
          className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-3 relative"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              #{idx + 1}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = [...value]
                next.splice(idx, 1)
                onChange(next)
              }}
            >
              {t("arrayRemove")}
            </Button>
          </div>
          {Object.entries(field.children!).map(([childKey, childField]) => (
            <FieldRow
              key={childKey}
              fieldKey={childKey}
              fieldPath={`${fieldPath}[${idx}].${childKey}`}
              field={childField}
              value={row[childKey] ?? childField.default ?? ""}
              errors={errors}
              onChange={(v) => {
                const next = [...value]
                next[idx] = { ...row, [childKey]: v }
                onChange(next)
              }}
            />
          ))}
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...value, emptyRow()])}
      >
        {t("arrayAdd")}
      </Button>
    </div>
  )
}

function OneOfGroup({
  field,
  fieldPath,
  value,
  errors,
  onChange,
  t,
}: {
  field: SchemaField
  fieldPath: string
  value: Record<string, unknown>
  errors: Record<string, string>
  onChange: (v: unknown) => void
  t: (key: string) => string
}) {
  const variants = field.variants ?? []
  const variantKey =
    typeof value.__variant === "string" && variants.some((v) => v.label === value.__variant)
      ? (value.__variant as string)
      : variants[0]?.label
  if (!variantKey) return null
  const variant = variants.find((v) => v.label === variantKey) ?? variants[0]
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-3">
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("oneOfVariant")}
        </Label>
        <Select
          value={variantKey}
          onValueChange={(nextVariant) =>
            onChange({
              ...seedValues(variants.find((v) => v.label === nextVariant)?.fields ?? {}, {}),
              __variant: nextVariant,
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {variants.map((v) => (
              <SelectItem key={v.label} value={v.label}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {Object.entries(variant.fields).map(([childKey, childField]) => (
        <FieldRow
          key={childKey}
          fieldKey={childKey}
          fieldPath={`${fieldPath}.${childKey}`}
          field={childField}
          value={value[childKey] ?? childField.default ?? ""}
          errors={errors}
          onChange={(v) => onChange({ ...value, __variant: variantKey, [childKey]: v })}
        />
      ))}
    </div>
  )
}
