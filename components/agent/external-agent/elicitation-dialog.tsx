"use client"

/**
 * Blocking-question dialog for external agents.
 *
 * The sibling of `tool-approval-dialog.tsx`, and deliberately not the same
 * component. An approval grants a capability and answers allow / deny / always;
 * an elicitation collects a VALUE — a choice, some text, a yes/no — and has no
 * "always" to offer. Folding the two together would either give approvals a
 * form or give questions an authority they do not have.
 *
 * Both Pi and ACP feed this. Pi's `confirm` / `select` / `input` / `editor`
 * arrive as a one-property schema named for the method
 * (`piDialogSchema`); ACP's `elicitation/create` can send a richer object. The
 * renderer works off the schema rather than off either protocol, so neither is
 * special-cased here.
 *
 * Closing without answering is a `cancel`, never a `decline`: the agent reads
 * decline as a deliberate "no" and cancel as "the user walked away", and a
 * dismissed dialog is the second thing.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, MessageCircleQuestion, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  AcpElicitationPropertySchema,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpElicitationValue,
} from "@/types/agent/external-agent"

export interface ExternalAgentElicitationDialogProps {
  /** The open question, or `null` when nothing is pending. */
  request: AcpElicitationRequest | null
  /** Answer the question. Always called exactly once per request. */
  onRespond: (response: AcpElicitationResponse) => void
}

/** The choices a string property offers, from either ACP spelling. */
function choicesOf(schema: AcpElicitationPropertySchema): Array<{ value: string; label: string }> {
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

function initialValues(
  properties: Record<string, AcpElicitationPropertySchema>
): Record<string, AcpElicitationValue> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, initialValue(schema)])
  )
}

/** Is every required field filled in? Blank strings and empty arrays are not. */
function isComplete(
  properties: Record<string, AcpElicitationPropertySchema>,
  required: string[],
  values: Record<string, AcpElicitationValue>
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

export function ExternalAgentElicitationDialog({
  request,
  onRespond,
}: ExternalAgentElicitationDialogProps) {
  if (!request) return null

  return <ExternalAgentElicitationForm key={request.id} request={request} onRespond={onRespond} />
}

function ExternalAgentElicitationForm({
  request,
  onRespond,
}: {
  request: AcpElicitationRequest
  onRespond: (response: AcpElicitationResponse) => void
}) {
  const t = useTranslations("externalAgent.elicitation")
  const properties = request.requestedSchema?.properties ?? {}
  const required = request.requestedSchema?.required ?? []
  const [values, setValues] = useState<Record<string, AcpElicitationValue>>(() =>
    initialValues(properties)
  )

  const setValue = (key: string, value: AcpElicitationValue) =>
    setValues((prev) => ({ ...prev, [key]: value }))

  const respond = (action: AcpElicitationResponse["action"]) =>
    onRespond({
      requestId: request.id,
      action,
      content: action === "accept" ? values : undefined,
    })

  const complete = isComplete(properties, required, values)
  const title = request.requestedSchema?.title || t("title")

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Dismissal is a cancel, not a decline.
        if (!open) respond("cancel")
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleQuestion className="size-4 text-muted-foreground" aria-hidden />
            {title}
          </DialogTitle>
          <DialogDescription>{request.message}</DialogDescription>
        </DialogHeader>

        {request.mode === "url" ? (
          <div className="space-y-2 text-sm">
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
            {request.origin ? (
              <p className="text-muted-foreground text-xs">{request.origin}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(properties).map(([key, schema]) => {
              const fieldId = `elicitation-${request.id}-${key}`
              const label = schema.title || key
              const choices = choicesOf(schema)
              const value = values[key]

              return (
                <div key={key} className="space-y-2">
                  {schema.type === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={fieldId}
                        checked={value === true}
                        onCheckedChange={(checked) => setValue(key, checked === true)}
                      />
                      <Label htmlFor={fieldId}>{label}</Label>
                    </div>
                  ) : (
                    <>
                      <Label htmlFor={fieldId}>{label}</Label>
                      {choices.length > 0 ? (
                        <RadioGroup
                          value={typeof value === "string" ? value : ""}
                          onValueChange={(next) => setValue(key, next)}
                        >
                          {choices.map((choice) => (
                            <div key={choice.value} className="flex items-center gap-2">
                              <RadioGroupItem
                                id={`${fieldId}-${choice.value}`}
                                value={choice.value}
                              />
                              <Label htmlFor={`${fieldId}-${choice.value}`} className="font-normal">
                                {choice.label}
                              </Label>
                            </div>
                          ))}
                        </RadioGroup>
                      ) : schema.format === "multiline" || schema.default !== undefined ? (
                        // A prefilled string is an `editor` dialog: the user is
                        // meant to revise a body of text, not retype one line.
                        <Textarea
                          id={fieldId}
                          rows={6}
                          value={typeof value === "string" ? value : ""}
                          placeholder={schema.description}
                          onChange={(event) => setValue(key, event.target.value)}
                        />
                      ) : (
                        <Input
                          id={fieldId}
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
                  {schema.description && choices.length > 0 ? (
                    <p className="text-muted-foreground text-xs">{schema.description}</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => respond("decline")}>
            {t("decline")}
          </Button>
          <Button disabled={!complete} onClick={() => respond("accept")}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
