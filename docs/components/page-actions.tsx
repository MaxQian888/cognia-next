"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

// Relative rather than `@/`: the repo's Jest runner maps that alias to the
// app root, not to `docs/`.
import { copyMarkdown, type CopyResult } from "../lib/copy-markdown"

type Props = {
  /** Href of this page's Markdown twin, from `lib/llms-format.markdownHref`. */
  markdownHref: string
}

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-2.5 py-1 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"

/**
 * "Copy Markdown" / "View Markdown" for the current page.
 *
 * Both point at the static `.md` twin emitted by `app/md/[lang]/[[...slug]]`,
 * which is the same text `/llms.txt` indexes — so what a reader pastes into a
 * model is exactly what the site publishes for machines.
 *
 */
export function PageActions({ markdownHref }: Props) {
  const [state, setState] = useState<CopyResult | "idle">("idle")
  const t = useTranslations("docsSite.pageActions")

  async function onCopy() {
    const result = await copyMarkdown(markdownHref, {
      fetch: (input) => fetch(input),
      writeText: (value) => navigator.clipboard.writeText(value),
    })
    setState(result)
    // Let the reader retry; a permanent "failed" label reads as broken UI.
    setTimeout(() => setState("idle"), 2000)
  }

  return (
    <div className="not-prose mb-6 flex flex-wrap items-center gap-2">
      <button type="button" onClick={onCopy} className={BUTTON_CLASS}>
        {state === "idle" ? t("idle") : state === "copied" ? t("copied") : t("failed")}
      </button>

      <a href={markdownHref} target="_blank" rel="noreferrer" className={BUTTON_CLASS}>
        {t("view")}
      </a>
    </div>
  )
}
