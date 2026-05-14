"use client"

/**
 * Shared inspector form for every `action.desktop.*` node. Replaces the
 * generic JSON Fallback for the 11 desktop kinds.
 *
 * Common fields (always rendered):
 *   - selector  : UIA selector string (role/name/automationId/xpath-ish).
 *                 Optional for nodes that operate on the foreground window.
 *   - timeoutMs : how long to wait for the element / operation to settle.
 *   - retries   : non-negative retry count for transient failures.
 *
 * Per-kind extras are injected via `extraFields` so each thin shell only
 * declares the parameters that node actually consumes (e.g., `text` for
 * `type`, `pattern` for `invokePattern`, …).
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, patchParam, readNumber, readString } from "../shared"

export interface DesktopActionFormProps {
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** Hint shown beneath the selector input. */
  selectorHint?: string
  /** Show the selector input. Defaults to true; window-resize / window-close
   *  hide it because they operate on the foreground window by default. */
  showSelector?: boolean
  /** Per-kind specific fields rendered below the shared block. */
  extraFields?: ReactNode
  /** Override the textarea placeholder when the consumer prefers different copy. */
  selectorPlaceholder?: string
}

export function DesktopActionForm({
  params,
  onChange,
  selectorHint,
  showSelector = true,
  extraFields,
  selectorPlaceholder,
}: DesktopActionFormProps) {
  const t = useTranslations("workflows.forms.desktopShared")
  const selector = readString(params, "selector")
  const timeoutMs = readNumber(params, "timeoutMs", 5000)
  const retries = readNumber(params, "retries", 0)
  const resolvedSelectorHint = selectorHint ?? t("selector.defaultHint")
  const resolvedSelectorPlaceholder = selectorPlaceholder ?? t("selector.defaultPlaceholder")

  return (
    <FieldGroup>
      {showSelector && (
        <Field
          label={t("selector.label")}
          htmlFor="desktop-selector"
          hint={resolvedSelectorHint}
          name="selector"
        >
          <Textarea
            id="desktop-selector"
            rows={2}
            placeholder={resolvedSelectorPlaceholder}
            value={selector}
            onChange={(e) => onChange(patchParam(params, "selector", e.target.value))}
            className="font-mono text-xs"
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("timeout.label")} htmlFor="desktop-timeout" name="timeoutMs">
          <Input
            id="desktop-timeout"
            type="number"
            min={0}
            value={timeoutMs}
            onChange={(e) =>
              onChange(patchParam(params, "timeoutMs", Math.max(0, Number(e.target.value) || 0)))
            }
          />
        </Field>
        <Field label={t("retries.label")} htmlFor="desktop-retries" name="retries">
          <Input
            id="desktop-retries"
            type="number"
            min={0}
            value={retries}
            onChange={(e) =>
              onChange(patchParam(params, "retries", Math.max(0, Number(e.target.value) || 0)))
            }
          />
        </Field>
      </div>
      {extraFields}
    </FieldGroup>
  )
}
