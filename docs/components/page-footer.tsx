// Relative rather than `@/`: the repo's Jest runner maps that alias to the app
// root, not to `docs/`, and this component has tests.
import { formatDocsDate } from "../lib/time-zone"

const REPO = "MaxQian888/cognia-next"
const BRANCH = "master"

type Props = {
  /** Page slug, e.g. ["en", "getting-started"]. May be empty for the index. */
  slug: string[]
  /**
   * Repo-relative path of the page's source file. Comes from fumadocs'
   * `page.path`, so locale-shared pages (`content/docs/plugin-dev/**`) link
   * to the file that actually exists rather than a guessed `{lang}/` path.
   */
  sourcePath: string
  /** Build-time last-modified ISO string (or null). */
  lastModified?: string | null
}

function detectLocale(slug: string[]): "en" | "zh" | null {
  if (slug[0] === "en") return "en"
  if (slug[0] === "zh") return "zh"
  return null
}

export function buildEditPath(sourcePath: string): string {
  return `https://github.com/${REPO}/edit/${BRANCH}/${sourcePath}`
}

function buildAlternateHref(slug: string[]): string | null {
  const locale = detectLocale(slug)
  if (!locale) return null
  const target = locale === "en" ? "zh" : "en"
  const rest = slug.slice(1).join("/")
  return rest ? `/docs/${target}/${rest}` : `/docs/${target}`
}

export function buildFeedbackHref(slug: string[], sourcePath: string, helpful: boolean): string {
  const path = slug.length > 0 ? slug.join("/") : "index"
  const sentiment = helpful ? "Helpful" : "Needs improvement"
  const title = `[Docs feedback] ${sentiment}: ${path}`
  const body = [
    `Page: https://github.com/${REPO}/blob/${BRANCH}/${sourcePath}`,
    "",
    helpful ? "What was especially useful?" : "What should we improve?",
    "",
  ].join("\n")
  return `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=documentation`
}

export function PageFooter({ slug, sourcePath, lastModified }: Props) {
  const editHref = buildEditPath(sourcePath)
  const altHref = buildAlternateHref(slug)
  const locale = detectLocale(slug)
  const altLabel = locale === "en" ? "中文版本" : locale === "zh" ? "English version" : null
  const lastModifiedLabel = lastModified ? formatDocsDate(lastModified, locale) : null

  return (
    <footer className="not-prose mt-16 space-y-6 border-t border-fd-border pt-8 text-sm text-fd-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <a
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
          </a>

          {altHref && altLabel ? (
            <a
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
            </a>
          ) : null}
        </div>

        {lastModified && lastModifiedLabel ? (
          <span className="text-xs">
            Last updated: <time dateTime={lastModified}>{lastModifiedLabel}</time>
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-fd-border bg-fd-card/50 px-4 py-3">
        <span className="text-sm">
          {locale === "zh" ? "这页有用吗？" : "Was this page helpful?"}
        </span>
        <div className="flex gap-2">
          <a
            href={buildFeedbackHref(slug, sourcePath, true)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={locale === "zh" ? "有帮助" : "Helpful"}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-fd-border transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            👍
          </a>
          <a
            href={buildFeedbackHref(slug, sourcePath, false)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={locale === "zh" ? "没有帮助" : "Not helpful"}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-fd-border transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            👎
          </a>
        </div>
      </div>
    </footer>
  )
}
