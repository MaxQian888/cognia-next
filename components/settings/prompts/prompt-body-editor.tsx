"use client"

/**
 * The Prompt Center's text editor (ADR-0236 §4): a plain textarea, so the
 * owner's formatting survives untouched, with the definition's variables as
 * chips that insert `{{name}}` at the caret and the validation issues the
 * service would refuse a publish for, computed as the user types. Nothing
 * here calls a model.
 */

import { useRef } from "react"
import { BracesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { PromptValidationIssue } from "@/lib/prompts/template"
import type { PromptVariableSpec } from "@/lib/prompts/types"
import { cn } from "@/lib/utils"
import { usePromptLabels } from "./use-prompt-labels"

export interface PromptBodyEditorProps {
  value: string
  onChange(value: string): void
  /** Variables the body may reference; chips are offered for each. */
  variables?: readonly PromptVariableSpec[]
  issues?: readonly PromptValidationIssue[]
  maxChars?: number
  readOnly?: boolean
  label: string
}

export function PromptBodyEditor({
  value,
  onChange,
  variables = [],
  issues = [],
  maxChars,
  readOnly = false,
  label,
}: PromptBodyEditorProps) {
  const { t } = usePromptLabels()
  const ref = useRef<HTMLTextAreaElement>(null)

  const insert = (name: string) => {
    const token = `{{${name}}}`
    const area = ref.current
    const start = area?.selectionStart ?? value.length
    const end = area?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + token + value.slice(end))
    // Put the caret after the inserted token once React has rendered it.
    requestAnimationFrame(() => {
      if (!ref.current) return
      ref.current.focus()
      ref.current.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const over = maxChars !== undefined && value.length > maxChars

  return (
    <div className="space-y-2" data-testid="prompt-body-editor">
      {variables.length > 0 && !readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("editor.variables")}</span>
          {variables.map((variable) => (
            <Button
              key={variable.name}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-1.5 font-mono text-[11px]"
              onClick={() => insert(variable.name)}
              aria-label={t("editor.insertVariable", { name: variable.name })}
              title={
                variable.required
                  ? t("editor.variableRequired", { max: variable.maxChars })
                  : t("editor.variableOptional", { max: variable.maxChars })
              }
            >
              <BracesIcon className="size-3" />
              {variable.name}
              {variable.required ? <span className="text-destructive">*</span> : null}
            </Button>
          ))}
        </div>
      ) : null}
      <Textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        aria-label={label}
        aria-invalid={issues.length > 0 || over}
        spellCheck={false}
        className={cn(
          "min-h-[260px] resize-y font-mono text-xs leading-relaxed",
          readOnly && "bg-muted/40"
        )}
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <ul className="space-y-0.5" aria-live="polite" data-testid="prompt-body-issues">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="text-[11px] text-destructive">
              {issueMessage(t, issue)}
            </li>
          ))}
        </ul>
        {maxChars !== undefined ? (
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 tabular-nums text-[10px]",
              over && "border-destructive text-destructive"
            )}
          >
            {t("editor.length", { length: value.length, max: maxChars })}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}

export function issueMessage(
  t: ReturnType<typeof usePromptLabels>["t"],
  issue: PromptValidationIssue
): string {
  switch (issue.code) {
    case "too-long":
      return t("issues.tooLong", { limit: issue.limit, length: issue.length })
    case "unknown-variable":
      return t("issues.unknownVariable", { name: issue.name })
    case "missing-variable":
      return t("issues.missingVariable", { name: issue.name })
    case "missing-fragment":
      return t("issues.missingFragment", { fragment: issue.fragment })
    case "empty":
      return t("issues.empty")
    case "malformed-placeholder":
      return t("issues.malformedPlaceholder")
    case "pii":
      return t("issues.pii")
    case "not-editable":
      return t("issues.notEditable")
  }
}
