"use client"

/**
 * One control for one declared template input.
 *
 * `TemplateInputSpec` describes thirteen kinds, four of which name a registry
 * the app can already read (`model`, `skill`, `character`, `workflow`) and two
 * more that are closed sets (`enum`, `boolean`). The Studio rendered a plain
 * text `<Input>` for every one of them, so binding a template to a character
 * meant typing a `chr_…` id from memory and finding out at preflight whether it
 * was right. The chat-template surface, by contrast, opens real pickers.
 *
 * The pickers come from the workflow inspector's shared family rather than new
 * ones: they are entity pickers that happen to live under that folder, they
 * read the same Dexie tables and settings store, and a second set would be a
 * second thing to keep in step.
 */

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CharacterPicker,
  ModelPicker,
  SkillMultiPicker,
  SkillPicker,
  SubworkflowPicker,
  ToolPicker,
  TwinPicker,
} from "@/components/workflow/editor/inspector/forms/shared/entity-picker"
import type { TemplateInputSpec } from "@/lib/templates/contracts"

export interface TemplateBindingFieldProps {
  input: TemplateInputSpec
  value: string
  onChange: (next: string) => void
}

/** Bindings are a flat `Record<string,string>`, so a multi-pick joins. */
const MULTI_SEPARATOR = ","

function splitMulti(value: string): string[] {
  return value
    .split(MULTI_SEPARATOR)
    .map((v) => v.trim())
    .filter(Boolean)
}

export function TemplateBindingField({ input, value, onChange }: TemplateBindingFieldProps) {
  const t = useTranslations("templateStudio")
  const id = `binding-${input.id}`
  const allowMultiple = "selector" in input && input.selector?.allowMultiple === true ? true : false

  const control = (() => {
    switch (input.kind) {
      case "boolean":
        return (
          <Switch
            id={id}
            checked={value === "true"}
            onCheckedChange={(next) => onChange(next ? "true" : "false")}
          />
        )
      case "number":
        return (
          <Input
            id={id}
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t(`inputKinds.${input.kind}`)}
          />
        )
      case "enum":
        return (
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger id={id}>
              <SelectValue placeholder={t(`inputKinds.${input.kind}`)} />
            </SelectTrigger>
            <SelectContent>
              {input.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      case "model":
        return <ModelPicker id={id} value={value} onChange={onChange} />
      case "character":
        return <CharacterPicker id={id} value={value} onChange={onChange} />
      case "workflow":
        return <SubworkflowPicker id={id} value={value} onChange={onChange} />
      case "twinSlot":
        return <TwinPicker id={id} value={value} onChange={onChange} />
      case "skill":
        return allowMultiple ? (
          <SkillMultiPicker
            id={id}
            value={splitMulti(value)}
            onChange={(next) => onChange(next.join(MULTI_SEPARATOR))}
          />
        ) : (
          <SkillPicker id={id} value={value} onChange={onChange} />
        )
      case "tool":
        return (
          <ToolPicker
            id={id}
            value={splitMulti(value)}
            onChange={(next) => onChange(next.join(MULTI_SEPARATOR))}
          />
        )
      default:
        // `string`, `provider`, `resource` and `secretRef`. None of them names
        // a registry this app can enumerate: a provider may be configured only
        // by base URL, a `resource` carries a free-form `resourceKind`, and a
        // secret is a keyring reference the Studio must never read back.
        return (
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t(`inputKinds.${input.kind}`)}
            {...(input.kind === "secretRef" ? { autoComplete: "off" } : {})}
          />
        )
    }
  })()

  return (
    <div className="space-y-2" data-testid={`template-binding-${input.id}`}>
      <Label htmlFor={id}>
        {input.label}
        {input.required ? ` ${t("inspector.required")}` : ""}
      </Label>
      {control}
      {/* `description` has been on the contract since the start and the Studio
          never rendered it, so the only guidance an author could give about
          their own input was the label. */}
      {input.description ? (
        <p className="text-xs text-muted-foreground">{input.description}</p>
      ) : null}
    </div>
  )
}
