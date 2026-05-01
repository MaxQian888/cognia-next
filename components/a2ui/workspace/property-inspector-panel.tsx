"use client"

/**
 * Property Inspector Panel
 * Edit properties of the selected A2UI component
 */

import React, { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Settings2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { useWorkspaceContext } from "./a2ui-workspace-context"

/** Component type → editable property schemas */
const PROPERTY_SCHEMAS: Record<
  string,
  Array<{
    key: string
    label: string
    type: "text" | "number" | "boolean" | "select" | "textarea"
    options?: string[]
  }>
> = {
  Text: [
    { key: "text", label: "Text", type: "text" },
    {
      key: "variant",
      label: "Variant",
      type: "select",
      options: ["body", "heading1", "heading2", "heading3", "heading4", "caption", "code", "label"],
    },
    { key: "align", label: "Align", type: "select", options: ["left", "center", "right"] },
  ],
  Button: [
    { key: "label", label: "Label", type: "text" },
    {
      key: "variant",
      label: "Variant",
      type: "select",
      options: ["default", "primary", "secondary", "destructive", "outline", "ghost", "link"],
    },
    { key: "action", label: "Action", type: "text" },
    { key: "disabled", label: "Disabled", type: "boolean" },
  ],
  TextField: [
    { key: "placeholder", label: "Placeholder", type: "text" },
    { key: "label", label: "Label", type: "text" },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: ["text", "email", "password", "number", "url", "tel"],
    },
    { key: "disabled", label: "Disabled", type: "boolean" },
  ],
  TextArea: [
    { key: "placeholder", label: "Placeholder", type: "text" },
    { key: "label", label: "Label", type: "text" },
    { key: "rows", label: "Rows", type: "number" },
  ],
  Select: [
    { key: "placeholder", label: "Placeholder", type: "text" },
    { key: "label", label: "Label", type: "text" },
  ],
  Card: [
    { key: "title", label: "Title", type: "text" },
    { key: "padding", label: "Padding", type: "select", options: ["none", "sm", "md", "lg"] },
  ],
  Row: [
    { key: "gap", label: "Gap", type: "select", options: ["0", "1", "2", "3", "4", "6", "8"] },
    {
      key: "justify",
      label: "Justify",
      type: "select",
      options: ["start", "center", "end", "between", "around", "evenly"],
    },
    {
      key: "align",
      label: "Align",
      type: "select",
      options: ["start", "center", "end", "stretch"],
    },
    { key: "wrap", label: "Wrap", type: "boolean" },
  ],
  Column: [
    { key: "gap", label: "Gap", type: "select", options: ["0", "1", "2", "3", "4", "6", "8"] },
    {
      key: "align",
      label: "Align",
      type: "select",
      options: ["start", "center", "end", "stretch"],
    },
  ],
  Image: [
    { key: "src", label: "Source URL", type: "text" },
    { key: "alt", label: "Alt Text", type: "text" },
    { key: "width", label: "Width", type: "number" },
    { key: "height", label: "Height", type: "number" },
  ],
  Alert: [
    { key: "title", label: "Title", type: "text" },
    { key: "message", label: "Message", type: "text" },
    {
      key: "variant",
      label: "Variant",
      type: "select",
      options: ["default", "info", "success", "warning", "error", "destructive"],
    },
  ],
  Badge: [
    { key: "text", label: "Text", type: "text" },
    {
      key: "variant",
      label: "Variant",
      type: "select",
      options: ["default", "secondary", "destructive", "outline"],
    },
  ],
  Progress: [
    { key: "value", label: "Value", type: "number" },
    { key: "max", label: "Max", type: "number" },
    { key: "label", label: "Label", type: "text" },
  ],
  Slider: [
    { key: "min", label: "Min", type: "number" },
    { key: "max", label: "Max", type: "number" },
    { key: "step", label: "Step", type: "number" },
    { key: "label", label: "Label", type: "text" },
  ],
  Checkbox: [
    { key: "label", label: "Label", type: "text" },
    { key: "disabled", label: "Disabled", type: "boolean" },
  ],
  Divider: [
    {
      key: "orientation",
      label: "Orientation",
      type: "select",
      options: ["horizontal", "vertical"],
    },
  ],
  Spacer: [{ key: "size", label: "Size", type: "select", options: ["xs", "sm", "md", "lg", "xl"] }],
}

// Common properties for all components
const COMMON_PROPERTIES = [
  { key: "className", label: "CSS Class", type: "text" as const },
  { key: "visible", label: "Visible", type: "boolean" as const },
  { key: "weight", label: "Flex Weight", type: "number" as const },
]

export function PropertyInspectorPanel() {
  const t = useTranslations("a2ui")
  const { surfaceId, selectedComponentId } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const updateComponents = useA2UIStore((state) => state.updateComponents)

  const selectedComponent = useMemo(() => {
    if (!surface || !selectedComponentId) return null
    return surface.components[selectedComponentId] || null
  }, [surface, selectedComponentId])
  const selectedComponentRecord = selectedComponent as
    | (A2UIComponent & Record<string, unknown>)
    | null

  const handlePropertyChange = useCallback(
    (key: string, value: unknown) => {
      if (!surfaceId || !selectedComponentId || !surface) return
      const updatedComponents: Record<string, A2UIComponent> = {
        ...surface.components,
        [selectedComponentId]: {
          ...surface.components[selectedComponentId],
          [key]: value,
        } as A2UIComponent,
      }
      updateComponents(surfaceId, Object.values(updatedComponents))
    },
    [surfaceId, selectedComponentId, surface, updateComponents]
  )

  if (!selectedComponent) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4 gap-2">
        <Settings2 className="h-8 w-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{t("noComponentSelected")}</p>
        <p className="text-xs text-muted-foreground/60">{t("selectComponent")}</p>
      </div>
    )
  }

  const schema = PROPERTY_SCHEMAS[selectedComponent.component] || []

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("propertyInspector")}
        </span>
        <Badge variant="outline" className="text-[10px] h-5">
          {selectedComponent.component}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {/* Component ID */}
          <div>
            <Label className="text-[10px] text-muted-foreground">ID</Label>
            <p className="text-xs font-mono truncate">{selectedComponentId}</p>
          </div>

          <Separator />

          {/* Type-specific properties */}
          {schema.length > 0 && (
            <>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Properties
              </p>
              {schema.map((prop) => (
                <PropertyField
                  key={prop.key}
                  label={prop.label}
                  type={prop.type}
                  value={selectedComponentRecord?.[prop.key]}
                  options={prop.options}
                  onChange={(val) => handlePropertyChange(prop.key, val)}
                />
              ))}
              <Separator />
            </>
          )}

          {/* Common properties */}
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Layout
          </p>
          {COMMON_PROPERTIES.map((prop) => (
            <PropertyField
              key={prop.key}
              label={prop.label}
              type={prop.type}
              value={selectedComponentRecord?.[prop.key]}
              onChange={(val) => handlePropertyChange(prop.key, val)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

interface PropertyFieldProps {
  label: string
  type: "text" | "number" | "boolean" | "select" | "textarea"
  value: unknown
  options?: string[]
  onChange: (value: unknown) => void
}

function PropertyField({ label, type, value, options, onChange }: PropertyFieldProps) {
  switch (type) {
    case "boolean":
      return (
        <div className="flex items-center justify-between">
          <Label className="text-xs">{label}</Label>
          <Switch checked={!!value} onCheckedChange={(checked) => onChange(checked)} />
        </div>
      )
    case "select":
      return (
        <div className="space-y-1">
          <Label className="text-xs">{label}</Label>
          <Select value={String(value || "")} onValueChange={onChange}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              {options?.map((opt) => (
                <SelectItem key={opt} value={opt} className="text-xs">
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    case "number":
      return (
        <div className="space-y-1">
          <Label className="text-xs">{label}</Label>
          <Input
            type="number"
            value={value != null ? String(value) : ""}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            className="h-7 text-xs"
          />
        </div>
      )
    default:
      return (
        <div className="space-y-1">
          <Label className="text-xs">{label}</Label>
          <Input
            value={String(value || "")}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
      )
  }
}
