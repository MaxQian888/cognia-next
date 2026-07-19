"use client"

/** Property-safe inspector for built-in and custom A2UI components. */

import React, { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Settings2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  getA2UIEnumPropertyDefinition,
  getA2UIEnumPropertyDefinitions,
  getEditableComponentProperties,
  getEditableStructuralMetadata,
  replaceEditableComponentProperties,
  replaceEditableStructuralMetadata,
} from "@/lib/a2ui/component-properties"
import type { A2UIEnumPropertyDefinition } from "@/lib/a2ui/component-properties"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext } from "./a2ui-workspace-context"

const MULTILINE_PROPERTIES = new Set([
  "audioPrompt",
  "caption",
  "content",
  "description",
  "emptyMessage",
  "emptyText",
  "fallbackContent",
  "helperText",
  "message",
  "scenePrompt",
])
const UNSET_PROPERTY_VALUE = "__a2ui_unset_property__"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPathBinding(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string" && Object.keys(value).length === 1
}

function parsePropertyObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function PropertyInspectorPanel() {
  const t = useTranslations("a2ui")
  const { surfaceId, selectedComponentId } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const updateComponents = useA2UIStore((state) => state.updateComponents)
  const selectedComponent = useMemo(() => {
    if (!surface || !selectedComponentId) return null
    return surface.components[selectedComponentId] ?? null
  }, [selectedComponentId, surface])
  const editableProperties = useMemo(
    () => (selectedComponent ? getEditableComponentProperties(selectedComponent) : {}),
    [selectedComponent]
  )
  const structuralMetadata = useMemo(
    () => (selectedComponent ? getEditableStructuralMetadata(selectedComponent) : {}),
    [selectedComponent]
  )
  const propertyKeys = useMemo(() => {
    const keys = new Set(Object.keys(editableProperties))
    if (selectedComponent) {
      for (const definition of getA2UIEnumPropertyDefinitions(selectedComponent.component)) {
        keys.add(definition.property)
      }
    }
    return Array.from(keys)
  }, [editableProperties, selectedComponent])
  const serializedProperties = useMemo(
    () => JSON.stringify(editableProperties, null, 2),
    [editableProperties]
  )
  const draftVersion = `${selectedComponentId ?? ""}:${serializedProperties}`
  const [trackedDraftVersion, setTrackedDraftVersion] = useState(draftVersion)
  const [advancedDraft, setAdvancedDraft] = useState(serializedProperties)
  const [advancedError, setAdvancedError] = useState(false)
  if (trackedDraftVersion !== draftVersion) {
    setTrackedDraftVersion(draftVersion)
    setAdvancedDraft(serializedProperties)
    setAdvancedError(false)
  }

  const replaceProperties = useCallback(
    (properties: Record<string, unknown>) => {
      if (!selectedComponent) return false
      const nextComponent = replaceEditableComponentProperties(selectedComponent, properties)
      if (!nextComponent) return false
      updateComponents(surfaceId, [nextComponent])
      return true
    },
    [selectedComponent, surfaceId, updateComponents]
  )

  const handlePropertyChange = useCallback(
    (key: string, value: unknown) => {
      replaceProperties({ ...editableProperties, [key]: value })
    },
    [editableProperties, replaceProperties]
  )

  const handlePropertyRemove = useCallback(
    (key: string) => {
      const nextProperties = { ...editableProperties }
      delete nextProperties[key]
      replaceProperties(nextProperties)
    },
    [editableProperties, replaceProperties]
  )

  const handleStructuralMetadataChange = useCallback(
    (key: string, value: unknown) => {
      if (!selectedComponent) return false
      const nextComponent = replaceEditableStructuralMetadata(selectedComponent, {
        ...structuralMetadata,
        [key]: value,
      })
      if (!nextComponent) return false
      updateComponents(surfaceId, [nextComponent])
      return true
    },
    [selectedComponent, structuralMetadata, surfaceId, updateComponents]
  )

  if (!selectedComponent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <Settings2 className="size-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{t("noComponentSelected")}</p>
        <p className="text-xs text-muted-foreground/60">{t("selectComponent")}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("propertyInspector")}
        </span>
        <Badge variant="outline" className="h-5 text-[10px]">
          {selectedComponent.component}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-3">
          <div>
            <Label className="text-[10px] text-muted-foreground">{t("componentId")}</Label>
            <p className="truncate font-mono text-xs">{selectedComponentId}</p>
          </div>

          <Separator />

          <section className="space-y-3" aria-labelledby="property-fields-heading">
            <p
              id="property-fields-heading"
              className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {t("propertyFields")}
            </p>
            {propertyKeys.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noEditableProperties")}</p>
            ) : (
              propertyKeys.map((key, index) => (
                <PropertyField
                  key={key}
                  fieldId={`component-property-${index}`}
                  propertyKey={key}
                  value={editableProperties[key]}
                  enumDefinition={
                    selectedComponent
                      ? getA2UIEnumPropertyDefinition(selectedComponent.component, key)
                      : undefined
                  }
                  onChange={(nextValue) => handlePropertyChange(key, nextValue)}
                  onRemove={() => handlePropertyRemove(key)}
                />
              ))
            )}
          </section>

          {Object.entries(structuralMetadata).length > 0 && (
            <>
              <Separator />

              <section className="space-y-3" aria-labelledby="structural-metadata-heading">
                <div className="space-y-1">
                  <p
                    id="structural-metadata-heading"
                    className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    {t("structuralMetadata")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("structuralMetadataDescription")}
                  </p>
                </div>
                {Object.entries(structuralMetadata).map(([key, value], index) => (
                  <StructuralMetadataField
                    key={key}
                    fieldId={`component-structural-metadata-${index}`}
                    metadataKey={key}
                    value={value}
                    onChange={(nextValue) => handleStructuralMetadataChange(key, nextValue)}
                  />
                ))}
              </section>
            </>
          )}

          <Separator />

          <section className="space-y-2" aria-labelledby="advanced-properties-heading">
            <p
              id="advanced-properties-heading"
              className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {t("advancedProperties")}
            </p>
            <p className="text-xs text-muted-foreground">{t("advancedPropertiesDescription")}</p>
            <Label htmlFor="editable-properties-json" className="sr-only">
              {t("editablePropertiesJson")}
            </Label>
            <Textarea
              id="editable-properties-json"
              aria-label={t("editablePropertiesJson")}
              value={advancedDraft}
              onChange={(event) => {
                setAdvancedDraft(event.target.value)
                setAdvancedError(false)
              }}
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
            />
            {advancedError && (
              <p role="alert" className="text-xs text-destructive">
                {t("invalidPropertyJson")}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setAdvancedDraft(serializedProperties)
                  setAdvancedError(false)
                }}
              >
                {t("reset")}
              </Button>
              <Button
                type="button"
                size="sm"
                aria-label={t("applyPropertyJson")}
                onClick={() => {
                  const properties = parsePropertyObject(advancedDraft)
                  if (!properties || !replaceProperties(properties)) {
                    setAdvancedError(true)
                  }
                }}
              >
                {t("apply")}
              </Button>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

interface StructuralMetadataFieldProps {
  fieldId: string
  metadataKey: string
  value: unknown
  onChange: (value: unknown) => boolean
}

function StructuralMetadataField({
  fieldId,
  metadataKey,
  value,
  onChange,
}: StructuralMetadataFieldProps) {
  const t = useTranslations("a2ui")
  const serializedValue = JSON.stringify(value, null, 2) ?? "null"
  const [trackedValue, setTrackedValue] = useState(serializedValue)
  const [draft, setDraft] = useState(serializedValue)
  const [invalid, setInvalid] = useState(false)
  if (trackedValue !== serializedValue) {
    setTrackedValue(serializedValue)
    setDraft(serializedValue)
    setInvalid(false)
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId} className="font-mono text-xs">
        {metadataKey}
      </Label>
      <Textarea
        id={fieldId}
        aria-label={t("structuralMetadataJsonLabel", { property: metadataKey })}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setInvalid(false)
        }}
        className="min-h-24 font-mono text-xs"
        spellCheck={false}
      />
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {t("invalidStructuralMetadata")}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={t("applyStructuralMetadata", { property: metadataKey })}
        onClick={() => {
          try {
            setInvalid(!onChange(JSON.parse(draft) as unknown))
          } catch {
            setInvalid(true)
          }
        }}
      >
        {t("apply")}
      </Button>
    </div>
  )
}

interface PropertyFieldProps {
  fieldId: string
  propertyKey: string
  value: unknown
  onChange: (value: unknown) => void
  enumDefinition?: A2UIEnumPropertyDefinition
  onRemove?: () => void
}

function PropertyField({
  fieldId,
  propertyKey,
  value,
  onChange,
  enumDefinition,
  onRemove,
}: PropertyFieldProps) {
  const t = useTranslations("a2ui")

  if (enumDefinition && (value === undefined || typeof value === "string")) {
    const options = enumDefinition.options.includes(value ?? "")
      ? enumDefinition.options
      : value === undefined
        ? enumDefinition.options
        : [value, ...enumDefinition.options]
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="font-mono text-xs">
          {propertyKey}
        </Label>
        <Select
          value={value ?? UNSET_PROPERTY_VALUE}
          onValueChange={(nextValue) => {
            if (nextValue === UNSET_PROPERTY_VALUE) onRemove?.()
            else onChange(nextValue)
          }}
        >
          <SelectTrigger id={fieldId} aria-label={propertyKey} className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET_PROPERTY_VALUE}>{t("notSet")}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  if (isPathBinding(value)) {
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="font-mono text-xs">
          {propertyKey}
        </Label>
        <Input
          id={fieldId}
          aria-label={t("propertyDataPath", { property: propertyKey })}
          value={value.path}
          onChange={(event) => onChange({ path: event.target.value })}
          className="h-8 font-mono text-xs"
        />
      </div>
    )
  }

  if (typeof value === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={fieldId} className="font-mono text-xs">
          {propertyKey}
        </Label>
        <Switch id={fieldId} aria-label={propertyKey} checked={value} onCheckedChange={onChange} />
      </div>
    )
  }

  if (typeof value === "number") {
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="font-mono text-xs">
          {propertyKey}
        </Label>
        <Input
          id={fieldId}
          aria-label={propertyKey}
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-8 text-xs"
        />
      </div>
    )
  }

  if (typeof value === "string") {
    const multiline = MULTILINE_PROPERTIES.has(propertyKey)
    return (
      <div className="space-y-1">
        <Label htmlFor={fieldId} className="font-mono text-xs">
          {propertyKey}
        </Label>
        {multiline ? (
          <Textarea
            id={fieldId}
            aria-label={propertyKey}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-20 text-xs"
          />
        ) : (
          <Input
            id={fieldId}
            aria-label={propertyKey}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 text-xs"
          />
        )}
      </div>
    )
  }

  return (
    <JsonPropertyField
      fieldId={fieldId}
      propertyKey={propertyKey}
      value={value}
      onChange={onChange}
    />
  )
}

function JsonPropertyField({ fieldId, propertyKey, value, onChange }: PropertyFieldProps) {
  const t = useTranslations("a2ui")
  const serializedValue = JSON.stringify(value, null, 2) ?? "null"
  const [trackedValue, setTrackedValue] = useState(serializedValue)
  const [draft, setDraft] = useState(serializedValue)
  const [invalid, setInvalid] = useState(false)
  if (trackedValue !== serializedValue) {
    setTrackedValue(serializedValue)
    setDraft(serializedValue)
    setInvalid(false)
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={fieldId} className="font-mono text-xs">
        {propertyKey}
      </Label>
      <Textarea
        id={fieldId}
        aria-label={t("propertyJsonLabel", { property: propertyKey })}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setInvalid(false)
        }}
        className="min-h-24 font-mono text-xs"
        spellCheck={false}
      />
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {t("invalidJson")}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={t("applyProperty", { property: propertyKey })}
        onClick={() => {
          try {
            onChange(JSON.parse(draft) as unknown)
          } catch {
            setInvalid(true)
          }
        }}
      >
        {t("apply")}
      </Button>
    </div>
  )
}
