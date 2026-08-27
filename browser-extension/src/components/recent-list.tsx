import type { BrowserContextSubmissionSummaryV1 } from "@cognia/companion-client"
import { Button, Card, CardContent } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { StatusPill } from "./status-pill"

export interface RecentListProps {
  api: BrowserApi
  items: BrowserContextSubmissionSummaryV1[]
}

/**
 * The tasks started from this browser.
 *
 * Title, source host, status. No instruction and no page text — neither is
 * stored anywhere the panel could read them, which is the point rather than a
 * limitation: this list lives on disk in a browser profile, and the transcript
 * that holds the real content lives in Cognia where the user can delete it.
 *
 * `needs_input` gets "continue in Cognia" rather than an approval control. The
 * panel deliberately cannot answer a prompt (ADR-0154 §1), and offering
 * something that looks like it could would be worse than offering nothing.
 */
export function RecentList({ api, items }: RecentListProps) {
  if (items.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground" data-testid="recent-empty">
        {api.message("recentEmpty")}
      </p>
    )
  }
  return (
    <ul className="space-y-1.5" data-testid="recent-list">
      {items.map((item) => (
        <li key={item.submissionId}>
          <Card>
            <CardContent className="space-y-1 px-2.5 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 min-w-0 shrink text-xs font-medium">{item.title}</p>
                <StatusPill api={api} status={item.status} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {item.sourceHost}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => void api.openUrl(item.deepLink)}
                >
                  {item.status === "needs_input"
                    ? api.message("continueInCognia")
                    : api.message("openInCognia")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
