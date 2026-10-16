import { useState } from "react"
import { Badge, Button } from "@cognia/plugin-ui"

import type { BrowserApi, TabRef } from "@ext/src/lib/browser-api"
import { shouldOfferCaptureMenu } from "@ext/src/lib/capture/capture-request"
import type { CapturedPage } from "@ext/src/lib/panel-state"

export interface ExtraPagesProps {
  api: BrowserApi
  pages: CapturedPage[]
  /** How many more pages the Host takes (`maxPages − 1`). */
  maxExtra: number
  /** Tabs already in the submission, never offered again. */
  usedTabIds: number[]
  /** Content bytes of the whole submission, and the Host's total budget. */
  totalBytes: number
  budgetBytes: number
  /** Read a tab the person picked; the origin permission is already granted. */
  onAdd: (tab: TabRef) => Promise<void>
  onRemove: (index: number) => void
}

function originPattern(url: string): string | null {
  try {
    return `${new URL(url).origin}/*`
  } catch {
    return null
  }
}

/**
 * Other tabs in the same submission (ADR-0228 §2).
 *
 * Seeing the window's tabs needs the optional `tabs` permission and reading
 * one needs its origin; both are asked for here, as the first thing the click
 * does — `chrome.permissions.request` must run inside the gesture, so it is
 * called before anything else is awaited, and it answers at once when the
 * grant already exists.
 */
export function ExtraPages({
  api,
  pages,
  maxExtra,
  usedTabIds,
  totalBytes,
  budgetBytes,
  onAdd,
  onRemove,
}: ExtraPagesProps) {
  const [tabs, setTabs] = useState<TabRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<number | null>(null)

  const full = pages.length >= maxExtra
  const overBudget = totalBytes > budgetBytes

  const openPicker = async () => {
    setError(null)
    const granted = await api.requestPermissions({ permissions: ["tabs"] })
    if (!granted) {
      setError(api.message("pagesTabsDenied"))
      return
    }
    const listed = await api.listTabs().catch(() => [])
    setTabs(listed.filter((tab) => shouldOfferCaptureMenu(tab.url) && !usedTabIds.includes(tab.id)))
  }

  const pick = async (tab: TabRef) => {
    setError(null)
    const pattern = originPattern(tab.url)
    const granted = pattern ? await api.requestPermissions({ origins: [pattern] }) : false
    if (!granted) {
      setError(api.message("pagesOriginDenied"))
      return
    }
    setAdding(tab.id)
    try {
      await onAdd(tab)
      setTabs(null)
    } catch {
      setError(api.message("pagesReadFailed"))
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="space-y-1.5" data-testid="extra-pages">
      {pages.length > 0 ? (
        <ul className="space-y-1">
          {pages.map((page, index) => (
            <li
              key={`${page.tabId}:${page.capturedAt}`}
              className="flex items-center justify-between gap-2 rounded-control border border-border px-2 py-1"
              data-testid={`extra-page-${index}`}
            >
              <span className="min-w-0 truncate text-xs" title={page.url}>
                {api.message("pagesPageLabel", [String(index + 2)])} {page.title || page.url}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => onRemove(index)}
                data-testid={`extra-page-remove-${index}`}
              >
                {api.message("remove")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={full}
          onClick={() => void openPicker()}
          data-testid="extra-pages-add"
        >
          {api.message("pagesAdd")}
        </Button>
        {pages.length > 0 ? (
          <Badge variant={overBudget ? "destructive" : "outline"} data-testid="extra-pages-budget">
            {api.message("pagesBudget", [
              (totalBytes / 1024).toFixed(1),
              (budgetBytes / 1024).toFixed(0),
            ])}
          </Badge>
        ) : null}
        {full ? (
          <span className="text-[11px] text-muted-foreground">{api.message("pagesFull")}</span>
        ) : null}
      </div>
      {tabs ? (
        <div
          className="space-y-1 rounded-control border border-border p-1.5"
          data-testid="extra-pages-picker"
        >
          {tabs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{api.message("pagesNoTabs")}</p>
          ) : (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {tabs.map((tab) => (
                <li key={tab.id}>
                  <button
                    type="button"
                    className="w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-accent disabled:opacity-50"
                    disabled={adding !== null}
                    title={tab.url}
                    onClick={() => void pick(tab)}
                    data-testid={`extra-pages-tab-${tab.id}`}
                  >
                    {adding === tab.id ? api.message("pagesReading") : tab.title || tab.url}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button size="sm" variant="ghost" onClick={() => setTabs(null)}>
            {api.message("cancel")}
          </Button>
        </div>
      ) : null}
      {overBudget ? (
        <p className="text-[11px] text-destructive" data-testid="extra-pages-over">
          {api.message("pagesOverBudget")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] text-destructive" data-testid="extra-pages-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
