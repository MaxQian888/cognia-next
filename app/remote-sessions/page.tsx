"use client"

/**
 * Remote Session Control — mobile "Remote sessions" entry.
 *
 * Master/detail: shows the host's session list; selecting one swaps in the
 * live `<RemoteSessionDetail>` view (stream + approvals + control). A back
 * affordance returns to the list and tears down the detail (which detaches
 * the watcher on unmount).
 *
 * `?session=` opens straight into one. That is what the needs-input push links
 * to (`needsInputHref` in `lib/companion/needs-input-notifier.ts`): without it
 * a tap landed on the bare list and the user had to find the blocked session by
 * hand, which is the whole latency the push exists to remove — and the approval
 * backstop is only 120s wide. The companion `?decision=` id needs no handling
 * here: the detail view already renders whichever decision the session is
 * blocked on.
 *
 * Read once, from `location`, rather than through `useSearchParams`: this is a
 * static export, so a `useSearchParams` caller has to sit behind its own
 * Suspense boundary, and the value is only ever an initial seed — the back
 * affordance must be able to return to the list without the query re-selecting.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { RemoteSessionsList } from "@/components/mobile/remote-sessions/remote-sessions-list"
import { RemoteSessionDetail } from "@/components/mobile/remote-sessions/remote-session-detail"

function initialSessionFromLink(): string | null {
  if (typeof window === "undefined") return null
  return new URLSearchParams(window.location.search).get("session") || null
}

export default function RemoteSessionsPage() {
  const t = useTranslations("mobile.remoteSessions")
  const [selected, setSelected] = useState<string | null>(initialSessionFromLink)

  return (
    <div className="flex h-full flex-col" data-bg-target="chat" data-testid="remote-sessions-page">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {selected ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setSelected(null)}
            aria-label={t("back")}
            data-testid="remote-sessions-back"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
        ) : null}
        <h1 className="text-sm font-semibold">{t("title")}</h1>
      </header>

      <div className="min-h-0 flex-1">
        {selected ? (
          <RemoteSessionDetail sessionId={selected} />
        ) : (
          <RemoteSessionsList onSelect={setSelected} />
        )}
      </div>
    </div>
  )
}
