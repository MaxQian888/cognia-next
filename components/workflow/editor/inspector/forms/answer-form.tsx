"use client"

import { useTranslations } from "next-intl"

import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, patchParam, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"
import type { ConfigProps } from "./form-support"

function readJson(params: Record<string, unknown>, rawKey: string, valueKey: string): string {
  const raw = readString(params, rawKey)
  if (raw) return raw
  const value = params[valueKey]
  return value === undefined ? "" : JSON.stringify(value, null, 2)
}

function patchJson(
  params: Record<string, unknown>,
  rawKey: string,
  valueKey: string,
  raw: string,
  expected: "any" | "array"
): Record<string, unknown> {
  const next = patchParam(params, rawKey, raw) as Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (expected === "array" && !Array.isArray(parsed)) {
      delete next[valueKey]
    } else {
      next[valueKey] = parsed
    }
  } catch {
    delete next[valueKey]
  }
  return next
}

export function AnswerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.answer")
  const suggestions = Array.isArray(params.suggestions)
    ? params.suggestions.filter((value): value is string => typeof value === "string").join("\n")
    : ""
  return (
    <FieldGroup>
      <Field label={t("text.label")} htmlFor="answer-text" hint={t("text.hint")} name="text">
        <ExpressionField
          id="answer-text"
          value={readString(params, "text")}
          onChange={(value) => onChange(patchParam(params, "text", value))}
          multiline
          rows={4}
        />
      </Field>
      <Field
        label={t("content.label")}
        htmlFor="answer-content"
        hint={t("content.hint")}
        name="content"
      >
        <Textarea
          id="answer-content"
          rows={4}
          value={readJson(params, "contentJson", "content")}
          onChange={(event) =>
            onChange(patchJson(params, "contentJson", "content", event.target.value, "any"))
          }
        />
      </Field>
      <Field
        label={t("citations.label")}
        htmlFor="answer-citations"
        hint={t("citations.hint")}
        name="citations"
      >
        <Textarea
          id="answer-citations"
          rows={5}
          value={readJson(params, "citationsJson", "citations")}
          onChange={(event) =>
            onChange(patchJson(params, "citationsJson", "citations", event.target.value, "array"))
          }
        />
      </Field>
      <Field label={t("files.label")} htmlFor="answer-files" hint={t("files.hint")} name="files">
        <Textarea
          id="answer-files"
          rows={4}
          value={readJson(params, "filesJson", "files")}
          onChange={(event) =>
            onChange(patchJson(params, "filesJson", "files", event.target.value, "array"))
          }
        />
      </Field>
      <Field
        label={t("suggestions.label")}
        htmlFor="answer-suggestions"
        hint={t("suggestions.hint")}
        name="suggestions"
      >
        <Textarea
          id="answer-suggestions"
          rows={3}
          value={suggestions}
          onChange={(event) =>
            onChange(
              patchParam(
                params,
                "suggestions",
                event.target.value
                  .split("\n")
                  .map((value) => value.trim())
                  .filter(Boolean)
              )
            )
          }
        />
      </Field>
    </FieldGroup>
  )
}
