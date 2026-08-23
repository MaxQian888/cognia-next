"use client"

/**
 * The fields of an elicitation, without any container.
 *
 * Extracted from `agent/external-agent/elicitation-dialog.tsx` so the remote
 * session queue can render the same form inside a Drawer alongside other open
 * decisions, instead of growing a second, poorer one. Everything protocol-shaped
 * stays here — how a choice, a secret, a prefilled body of text or a required
 * field is drawn — while the caller owns the chrome and the submit affordance.
 *
 * **Controlled on purpose.** The value lives with the caller, because the remote
 * surface has to survive a re-render when another decision arrives, a
 * reconnect, or a tab switch; state hidden inside the form would be lost each
 * time. {@link initialElicitationValues} and {@link isElicitationComplete} are
 * exported so a caller gets the defaults and the required-field rule without
 * reimplementing either.
 */

import { useTranslations } from "next-intl"
import { ExternalLink, TriangleAlert } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import type {
  AcpElicitationPropertySchema,
  AcpElicitationRequest,
  AcpElicitationValue,
} from "@/types/agent/external-agent"

export type ElicitationValues = Record<string, AcpElicitationValue>

/**
 * A schema fragment that can offer choices — a property, or an array's `items`.
 * Open-ended for the same reason `AcpElicitationPropertySchema` is: callers pass
 * whole schema objects, and the extra keys are none of this helper's business.
 */
interface ChoiceBearing {
  enum?: string[]
  oneOf?: Array<{ const: string; title?: string }>
  [key: string]: unknown
}

/**
 * The choices a schema offers, from either ACP spelling.
 *
 * Used at both levels: directly on a string property (a single choice) and on
 * an array's `items` (a multi-select). Reading `oneOf` first is what preserves
 * human labels — `enum` can only carry the raw values.
 */
export function elicitationChoices(schema: ChoiceBearing): Array<{ value: string; label: string }> {
  if (schema.oneOf?.length) {
    return schema.oneOf.map((option) => ({
      value: option.const,
      label: option.title ?? option.const,
    }))
  }
  if (schema.enum?.length) {
    return schema.enum.map((value) => ({ value, label: value }))
  }
  return []
}

/** The value a field starts at, so a supplied default is not silently dropped. */
function initialValue(schema: AcpElicitationPropertySchema): AcpElicitationValue {
  if (schema.default !== undefined) return schema.default
  switch (schema.type) {
    case "boolean":
      return false
    case "array":
      return []
    case "integer":
    case "number":
      return ""
    default:
      return ""
  }
}

export function initialElicitationValues(
  properties: Record<string, AcpElicitationPropertySchema>
): ElicitationValues {
  return Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, initialValue(schema)])
  )
}

/** Is every required field filled in? Blank strings and empty arrays are not. */
export function isElicitationComplete(
  properties: Record<string, AcpElicitationPropertySchema>,
  required: string[],
  values: ElicitationValues
): boolean {
  return required.every((key) => {
    if (!(key in properties)) return true
    const value = values[key]
    // A boolean is answered by being either true or false — `false` is a real
    // answer to "confirm?", not a missing one.
    if (properties[key].type === "boolean") return typeof value === "boolean"
    if (Array.isArray(value)) return value.length > 0
    return typeof value === "string" ? value.trim().length > 0 : value !== undefined
  })
}

export interface ElicitationFormProps {
  request: AcpElicitationRequest
  values: ElicitationValues
  onValuesChange: (next: ElicitationValues) => void
  /** Read-only rendering for a watcher who may see the question but not answer it. */
  disabled?: boolean
}

export function ElicitationForm({
  request,
  values,
  onValuesChange,
  disabled = false,
}: ElicitationFormProps) {
  const t = useTranslations("externalAgent.elicitation")
  const properties = request.requestedSchema?.properties ?? {}

  const setValue = (key: string, value: AcpElicitationValue) =>
    onValuesChange({ ...values, [key]: value })

  if (request.mode === "url") {
    return (
      <div className="space-y-2 text-sm" data-testid="elicitation-url">
        {request.hasPunycodeWarning ? (
          <p className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("punycodeWarning")}</span>
          </p>
        ) : null}
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 break-all underline underline-offset-4"
        >
          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          {request.url}
        </a>
        {request.origin ? <p className="text-muted-foreground text-xs">{request.origin}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="elicitation-form">
      {Object.entries(properties).map(([key, schema]) => {
        const fieldId = `elicitation-${request.id}-${key}`
        const label = schema.title || key
        const choices = elicitationChoices(schema)
        const value = values[key]

        const selected = Array.isArray(value)
          ? value.filter((v): v is string => typeof v === "string")
          : []

        return (
          <div key={key} className="space-y-2">
            {schema.type === "boolean" ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={fieldId}
                  disabled={disabled}
                  checked={value === true}
                  onCheckedChange={(checked) => setValue(key, checked === true)}
                />
                <Label htmlFor={fieldId}>{label}</Label>
              </div>
            ) : schema.type === "array" ? (
              // A multi-select. This used to fall through to the single-line
              // text input below, so an agent that asked the user to pick
              // several options got a box to type them into by hand.
              <fieldset className="space-y-2" aria-label={label}>
                <legend className="text-sm font-medium">{label}</legend>
                {elicitationChoices(schema.items ?? {}).map((choice) => {
                  const checked = selected.includes(choice.value)
                  return (
                    <div key={choice.value} className="flex items-center gap-2">
                      <Checkbox
                        id={`${fieldId}-${choice.value}`}
                        disabled={disabled}
                        checked={checked}
                        onCheckedChange={(next) =>
                          setValue(
                            key,
                            next === true
                              ? [...selected, choice.value]
                              : selected.filter((entry) => entry !== choice.value)
                          )
                        }
                      />
                      <Label htmlFor={`${fieldId}-${choice.value}`} className="font-normal">
                        {choice.label}
                      </Label>
                    </div>
                  )
                })}
              </fieldset>
            ) : (
              <>
                <Label htmlFor={fieldId}>{label}</Label>
                {choices.length > 0 ? (
                  <RadioGroup
                    value={typeof value === "string" ? value : ""}
                    disabled={disabled}
                    onValueChange={(next) => setValue(key, next)}
                  >
                    {choices.map((choice) => (
                      <div key={choice.value} className="flex items-center gap-2">
                        <RadioGroupItem id={`${fieldId}-${choice.value}`} value={choice.value} />
                        <Label htmlFor={`${fieldId}-${choice.value}`} className="font-normal">
                          {choice.label}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                ) : schema.format === "multiline" || schema.default !== undefined ? (
                  // A prefilled string is an `editor` dialog: the user is meant
                  // to revise a body of text, not retype one line.
                  <Textarea
                    id={fieldId}
                    rows={6}
                    disabled={disabled}
                    value={typeof value === "string" ? value : ""}
                    placeholder={schema.description}
                    onChange={(event) => setValue(key, event.target.value)}
                  />
                ) : (
                  <Input
                    id={fieldId}
                    disabled={disabled}
                    type={
                      schema.writeOnly
                        ? "password"
                        : schema.type === "integer" || schema.type === "number"
                          ? "number"
                          : "text"
                    }
                    value={typeof value === "string" ? value : ""}
                    placeholder={schema.description}
                    onChange={(event) => setValue(key, event.target.value)}
                  />
                )}
              </>
            )}
            {schema.description && (choices.length > 0 || schema.type === "array") ? (
              <p className="text-muted-foreground text-xs">{schema.description}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
