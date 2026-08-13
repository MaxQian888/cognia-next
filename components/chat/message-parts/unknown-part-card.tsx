"use client"

// gap1 — visible fallback for an unknown NON-tool message part. Previously the
// renderer returned null for any part type it didn't recognize, silently
// dropping it. This mirrors the unknown-`tool-` path (which always shows a
// generic card): a small collapsible that names the type and shows its JSON,
// so a stray/custom part is debuggable instead of invisible.

import { memo } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, HelpCircleIcon } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { CodeBlock } from "@/components/chat/renderers/code-block"

export interface UnknownPartCardProps {
  part: unknown
}

function partType(part: unknown): string {
  const t = (part as { type?: unknown })?.type
  return typeof t === "string" && t.length > 0 ? t : "unknown"
}

const MAX_DIAGNOSTIC_CHARS = 16_384
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|api[-_]?key)/i

export interface DiagnosticFallbackLabels {
  redacted: string
  circular: string
  truncated: string
  unavailable: string
}

export function safeDiagnosticJson(part: unknown, labels: DiagnosticFallbackLabels): string {
  const seen = new WeakSet<object>()
  try {
    const output = JSON.stringify(
      part,
      (key, value) => {
        if (SENSITIVE_KEY.test(key)) return labels.redacted
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return labels.circular
          seen.add(value)
        }
        return value
      },
      2
    )
    if (output.length <= MAX_DIAGNOSTIC_CHARS) return output
    return `${output.slice(0, MAX_DIAGNOSTIC_CHARS)}\n${labels.truncated}`
  } catch {
    return labels.unavailable
  }
}

export const UnknownPartCard = memo(function UnknownPartCard({ part }: UnknownPartCardProps) {
  const t = useTranslations("chat.message")
  const diagnosticT = useTranslations("chat.message.unknownPartDiagnostic")
  const type = partType(part)
  return (
    <div
      className="not-prose my-1 rounded-md border border-dashed bg-muted/20"
      data-testid="unknown-part-card"
      data-part-type={type}
    >
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
          <HelpCircleIcon className="size-3.5 shrink-0" />
          <span className="truncate">{t("unknownPart", { type })}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-2 pb-2">
          <CodeBlock
            code={safeDiagnosticJson(part, {
              redacted: diagnosticT("redacted"),
              circular: diagnosticT("circular"),
              truncated: diagnosticT("truncated"),
              unavailable: diagnosticT("unavailable"),
            })}
            language="json"
            showLineNumbers={false}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})
