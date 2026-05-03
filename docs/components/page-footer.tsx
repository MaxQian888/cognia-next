"use client"

import Link from "next/link"
import { useState } from "react"

const REPO = "MaxQian888/cognia-next"
const BRANCH = "master"
const DOCS_ROOT = "docs/content/docs"

type Props = {
  /** Page slug, e.g. ["en", "getting-started"]. May be empty for the index. */
  slug: string[]
  /** Build-time last-modified ISO string (or null). */
  lastModified?: string | null
}

function detectLocale(slug: string[]): "en" | "zh" | null {
  if (slug[0] === "en") return "en"
  if (slug[0] === "zh") return "zh"
  return null
}

function buildEditPath(slug: string[]): string {
  // Treat root index specially — it lives at content/docs/index.mdx.
  const path = slug.length === 0 ? "index.mdx" : `${slug.join("/")}.mdx`
  return `https://github.com/${REPO}/edit/${BRANCH}/${DOCS_ROOT}/${path}`
}

function buildAlternateHref(slug: string[]): string | null {
  const locale = detectLocale(slug)
  if (!locale) return null
  const target = locale === "en" ? "zh" : "en"
  const rest = slug.slice(1).join("/")
  return rest ? `/docs/${target}/${rest}` : `/docs/${target}`
}

export function PageFooter({ slug, lastModified }: Props) {
  const editHref = buildEditPath(slug)
  const altHref = buildAlternateHref(slug)
  const locale = detectLocale(slug)
  const altLabel = locale === "en" ? "中文版本" : locale === "zh" ? "English version" : null

  const [feedback, setFeedback] = useState<"up" | "down" | null>(null)

  return (
    <footer className="not-prose mt-16 space-y-6 border-t border-fd-border pt-8 text-sm text-fd-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={editHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-3 py-1.5 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
            </svg>
            Edit this page on GitHub
          </Link>

          {altHref && altLabel ? (
            <Link
              href={altHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-card px-3 py-1.5 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              {altLabel}
            </Link>
          ) : null}
        </div>

        {lastModified ? (
          <span className="text-xs">
            Last updated:{" "}
            <time dateTime={lastModified}>{new Date(lastModified).toLocaleDateString()}</time>
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-fd-border bg-fd-card/50 px-4 py-3">
        <span className="text-sm">
          {locale === "zh" ? "这页有用吗？" : "Was this page helpful?"}
        </span>
        {feedback ? (
          <span className="text-xs italic">
            {locale === "zh" ? "感谢反馈！" : "Thanks for the feedback!"}
          </span>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFeedback("up")}
              aria-label="Helpful"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-fd-border transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
            >
              👍
            </button>
            <button
              type="button"
              onClick={() => setFeedback("down")}
              aria-label="Not helpful"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-fd-border transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
            >
              👎
            </button>
          </div>
        )}
      </div>
    </footer>
  )
}
