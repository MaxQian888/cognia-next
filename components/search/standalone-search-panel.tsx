"use client"

// Standalone (BYOK) web-search surface: a question box that runs a multi-provider
// web search and renders a model-synthesized, cited answer plus the numbered
// sources. All work runs in-renderer via `useStandaloneSearch` →
// `runStandaloneSearchAnswer` (search + standalone provider synthesis); this
// component is purely presentational.

import Link from "next/link"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, SearchIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  useStandaloneSearch,
  type UseStandaloneSearchOptions,
} from "@/hooks/search/use-standalone-search"
import type { StandaloneSearchErrorCode } from "@/lib/search/standalone-answer"

/** Error codes whose remedy is configuring keys on the web-search settings page. */
const KEY_SETUP_CODES: StandaloneSearchErrorCode[] = ["no-search-provider", "no-model-provider"]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export interface StandaloneSearchPanelProps {
  /** Forwarded to the hook — test seam for the runner. */
  searchOptions?: UseStandaloneSearchOptions
}

export function StandaloneSearchPanel({ searchOptions }: StandaloneSearchPanelProps) {
  const t = useTranslations("mobile.standaloneSearch")
  const { query, setQuery, status, result, errorCode, errorMessage, run, cancel } =
    useStandaloneSearch(searchOptions ?? {})

  const loading = status === "loading"
  const canRun = query.trim().length > 0 && !loading

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (canRun) void run()
  }

  const errorLabel = errorCode ? t(`errors.${errorCode}`) : undefined

  return (
    <div className="flex flex-col gap-4" data-testid="standalone-search-panel">
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <Textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              if (canRun) void run()
            }
          }}
          placeholder={t("placeholder")}
          aria-label={t("queryAria")}
          rows={3}
          data-testid="standalone-search-input"
        />
        <div className="flex items-center justify-end gap-2">
          {loading ? (
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              data-testid="standalone-search-stop"
            >
              {t("stop")}
            </Button>
          ) : (
            <Button type="submit" disabled={!canRun} data-testid="standalone-search-run">
              <SearchIcon className="size-4" aria-hidden="true" />
              {t("run")}
            </Button>
          )}
        </div>
      </form>

      {loading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="standalone-search-loading"
        >
          <Spinner />
          {t("loading")}
        </div>
      )}

      {status === "error" && errorLabel && (
        <Alert variant="destructive" data-testid="standalone-search-error">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>{errorLabel}</AlertTitle>
          <AlertDescription>
            {errorMessage ? <p>{errorMessage}</p> : null}
            {errorCode && KEY_SETUP_CODES.includes(errorCode) ? (
              <Button asChild variant="link" className="h-auto p-0">
                <Link href="/me/web-search">{t("configureCta")}</Link>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      {status === "idle" && (
        <p className="text-sm text-muted-foreground" data-testid="standalone-search-hint">
          {t("idleHint")}
        </p>
      )}

      {status === "done" && result && (
        <div className="flex flex-col gap-4" data-testid="standalone-search-result">
          {result.modelUnavailable && (
            <Alert data-testid="standalone-search-model-unavailable">
              <AlertTriangleIcon aria-hidden="true" />
              <AlertTitle>{t("modelUnavailableTitle")}</AlertTitle>
              <AlertDescription>
                <Button asChild variant="link" className="h-auto p-0">
                  <Link href="/me/web-search">{t("configureCta")}</Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {result.answer ? (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("answerTitle")}
              </h2>
              <p
                className="whitespace-pre-wrap text-sm leading-relaxed"
                data-testid="standalone-search-answer"
              >
                {result.answer}
              </p>
            </section>
          ) : null}

          <section className="flex flex-col gap-1.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("sourcesTitle")}
            </h2>
            {result.sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noResults")}</p>
            ) : (
              <ol className="flex flex-col gap-2" data-testid="standalone-search-sources">
                {result.sources.map((s, i) => (
                  <li key={`${s.url}-${i}`} className="min-w-0">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn("block truncate text-sm text-primary hover:underline")}
                    >
                      <span className="text-muted-foreground">[{i + 1}]</span> {s.title || s.url}
                    </a>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {hostOf(s.url)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
