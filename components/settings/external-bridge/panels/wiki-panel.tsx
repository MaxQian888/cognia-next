"use client"

/**
 * Settings → External Bridge → Wiki maintenance.
 *
 * Rebuild and lint are the two scheduled jobs over the same corpus, so they
 * share a panel rather than each owning a nav entry. Both cards predate the
 * master/detail split and are self-contained.
 */

import { WikiRebuildCard } from "../wiki-rebuild-card"
import { WikiLintCard } from "../wiki-lint-card"

export function BridgeWikiPanel() {
  return (
    <div className="space-y-4">
      <WikiRebuildCard />
      <WikiLintCard />
    </div>
  )
}
