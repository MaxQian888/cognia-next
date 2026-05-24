"use client"

/**
 * Remote Session Control — mobile "Remote sessions" entry.
 *
 * Master/detail: shows the host's session list; selecting one swaps in the
 * live `<RemoteSessionDetail>` view (stream + approvals + control). A back
 * affordance returns to the list and tears down the detail (which detaches
 * the watcher on unmount).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { RemoteSessionsList } from "@/components/mobile/remote-sessions/remote-sessions-list"
import { RemoteSessionDetail } from "@/components/mobile/remote-sessions/remote-session-detail"

export default function RemoteSessionsPage() {
  const t = useTranslations("mobile.remoteSessions")
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col" data-testid="remote-sessions-page">
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
