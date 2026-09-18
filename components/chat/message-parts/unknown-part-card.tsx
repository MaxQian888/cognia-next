"use client"

// gap1 — visible fallback for an unknown NON-tool message part. Previously the
// renderer returned null for any part type it didn't recognize, silently
// dropping it. This mirrors the unknown-`tool-` path (which always shows a
// generic card): a small collapsible that names the type and shows its JSON,
// so a stray/custom part is debuggable instead of invisible.

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { HelpCircleIcon } from "lucide-react"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { ToolRowShell } from "@/components/chat/message-parts/tool-row"

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
  const [open, setOpen] = useState(false)
  const type = partType(part)
  return (
    // Shared row chrome — an unrecognised part is a muted status row whose
    // diagnostic payload expands under the left rule, same as a tool body.
    <div data-testid="unknown-part-card" data-part-type={type}>
      <ToolRowShell
        className="my-1"
        status="pending"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ariaLabel={t("unknownPart", { type })}
        testId="unknown-part-row"
        lead={
          <span className="truncate text-xs text-muted-foreground">
            {t("unknownPart", { type })}
          </span>
        }
        icon={<HelpCircleIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        target={<span className="flex-1" />}
      >
        <div className="mb-1 border-l pl-3 pt-1">
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
        </div>
      </ToolRowShell>
    </div>
  )
})
