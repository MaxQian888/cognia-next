"use client"

/**
 * Intent + severity for one review annotation.
 *
 * Extracted from the browser pane's inspection rail when the annotation queue
 * gained a second writer (the artifact preview). Deliberately NOT the whole
 * rail: that closes over roughly twenty-six bindings, several of them
 * browser-only — the native webview's capture rect, the `embedSetBounds`
 * animation clock, the Adjust controls' page URL — and a "shared" component
 * taking all of them as props would be a worse abstraction than two hosts.
 * What genuinely IS shared is this pair of selects and the queue list beside
 * it, so that is what moved.
 */

import { useTranslations } from "next-intl"

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type {
  BrowserAnnotationIntent,
  BrowserAnnotationSeverity,
} from "@/lib/db/browser-annotations"
import { cn } from "@/lib/utils"

/** The vocabularies, as values, so both hosts render the same options in the same order. */
export const ANNOTATION_INTENTS: readonly BrowserAnnotationIntent[] = [
  "fix",
  "change",
  "question",
  "approve",
]
export const ANNOTATION_SEVERITIES: readonly BrowserAnnotationSeverity[] = [
  "blocking",
  "important",
  "suggestion",
]

export interface AnnotationIntentControlsProps {
  intent: BrowserAnnotationIntent
  onIntentChange: (intent: BrowserAnnotationIntent) => void
  severity: BrowserAnnotationSeverity
  onSeverityChange: (severity: BrowserAnnotationSeverity) => void
  disabled?: boolean
  className?: string
}

export function AnnotationIntentControls({
  intent,
  onIntentChange,
  severity,
  onSeverityChange,
  disabled,
  className,
}: AnnotationIntentControlsProps) {
  const t = useTranslations("annotations")
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <NativeSelect
        value={intent}
        onChange={(event) => onIntentChange(event.target.value as BrowserAnnotationIntent)}
        aria-label={t("intent.label")}
        disabled={disabled}
        size="sm"
        className="h-7 text-xs"
      >
        {ANNOTATION_INTENTS.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {t(`intent.${value}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        value={severity}
        onChange={(event) => onSeverityChange(event.target.value as BrowserAnnotationSeverity)}
        aria-label={t("severity.label")}
        disabled={disabled}
        size="sm"
        className="h-7 text-xs"
      >
        {ANNOTATION_SEVERITIES.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {t(`severity.${value}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}
