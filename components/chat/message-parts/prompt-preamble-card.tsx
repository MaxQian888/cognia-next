"use client"

/**
 * What the composer attached to a user turn, shown in the bubble instead of the
 * raw context envelope (`lib/chat/prompt-preamble.ts`).
 *
 * The envelope is persisted in the message on purpose — a BYOK provider rebuilds
 * every later turn from the saved rows — so the bubble used to print it: pages of
 * `Referenced context:` and web results as though the user had typed them. This
 * folds it into one line that says what was attached, with the references listed
 * and the exact text the model received one more click away.
 *
 * No height animation: this sits in the reading area, where a collapsing box
 * moves every row under it (`reading-area-motion.guardrail.test.tsx`).
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, PaperclipIcon } from "lucide-react"

import {
  promptPreambleInnerText,
  type PromptPreambleReference,
  type PromptPreambleSectionKind,
  type PromptPreambleSummary,
} from "@/lib/chat/prompt-preamble"
import { cn } from "@/lib/utils"

export interface PromptPreambleCardProps {
  /** The envelope exactly as persisted. */
  preamble: string
  /** `metadata.promptPreamble`, when the send path recorded one. */
  summary: PromptPreambleSummary | null
  className?: string
}

/** Sections that are not references get a word of their own on the header. */
const EXTRA_SECTIONS: readonly Exclude<PromptPreambleSectionKind, "references">[] = [
  "webSearch",
  "reviewReceipts",
]

function isInAppHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//")
}

function ReferenceRow({ reference }: { reference: PromptPreambleReference }) {
  const t = useTranslations("chat.promptPreamble")
  const tEntity = useTranslations("chat.composer.popover.entityKinds")
  const noun =
    reference.kind === "entity" && reference.entityKind
      ? tEntity(reference.entityKind)
      : t(`kinds.${reference.kind}`)
  const title = reference.count
    ? t("combinedTitle", { title: reference.title, count: reference.count })
    : reference.title
  const label = (
    <>
      <span className="shrink-0 text-muted-foreground">{noun}</span>
      <span className="min-w-0 truncate">{title}</span>
    </>
  )
  const rowClass = "flex min-w-0 items-center gap-1.5"
  if (reference.href && isInAppHref(reference.href)) {
    return (
      <li>
        <Link
          href={reference.href}
          className={cn(rowClass, "hover:underline")}
          data-testid="prompt-preamble-reference"
        >
          {label}
        </Link>
      </li>
    )
  }
  if (reference.href) {
    return (
      <li>
        <a
          href={reference.href}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(rowClass, "hover:underline")}
          data-testid="prompt-preamble-reference"
        >
          {label}
        </a>
      </li>
    )
  }
  return (
    <li className={rowClass} data-testid="prompt-preamble-reference">
      {label}
    </li>
  )
}

export function PromptPreambleCard({ preamble, summary, className }: PromptPreambleCardProps) {
  const t = useTranslations("chat.promptPreamble")
  const [open, setOpen] = useState(false)
  const [showText, setShowText] = useState(false)

  const references = summary?.references ?? []
  const extras = EXTRA_SECTIONS.filter((kind) => summary?.sections.includes(kind))
  // Without a summary (a legacy row, or one a Host persisted from content alone)
  // the envelope can still be shown — it just cannot be itemised.
  const headline =
    references.length > 0 ? t("references", { count: references.length }) : t("generic")
  const inner = useMemo(
    () => (showText ? promptPreambleInnerText(preamble) : ""),
    [preamble, showText]
  )

  return (
    <div
      className={cn("mb-1.5 max-w-full text-xs text-muted-foreground", className)}
      data-testid="prompt-preamble-card"
    >
      <button
        type="button"
        className="flex max-w-full items-center gap-1.5 text-start hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="prompt-preamble-toggle"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0", open && "rotate-90")} aria-hidden />
        <PaperclipIcon className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-medium">{headline}</span>
        {extras.map((kind) => (
          <span
            key={kind}
            className="shrink-0 rounded-sm bg-muted px-1 py-px text-[10px]"
            data-testid={`prompt-preamble-section-${kind}`}
          >
            {t(`sections.${kind}`)}
          </span>
        ))}
      </button>
      {open ? (
        <div className="mt-1 space-y-1 border-s-2 border-border ps-2">
          {references.length > 0 ? (
            <ul className="space-y-0.5">
              {references.map((reference, index) => (
                <ReferenceRow
                  key={`${reference.kind}:${reference.title}:${index}`}
                  reference={reference}
                />
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className="hover:text-foreground hover:underline"
            onClick={() => setShowText((value) => !value)}
            data-testid="prompt-preamble-text-toggle"
          >
            {showText ? t("hideText") : t("showText")}
          </button>
          {showText ? (
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/60 p-2 font-mono text-[11px] leading-snug"
              data-testid="prompt-preamble-text"
            >
              {inner}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
