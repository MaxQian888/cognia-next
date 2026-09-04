"use client"

/**
 * The "what have I approved?" surface for the `approvedBinaries` ledger (v109).
 *
 * A durable grant the user can neither see nor withdraw is its own security
 * problem, so the ledger's only writer — the "remember this binary" checkbox on
 * the consent overlay — ships with this reader. Every row here is a binary the
 * user explicitly ticked; revoking one sends the next spawn back through the
 * consent prompt.
 *
 * The truncated SHA-256 is deliberate: it is the thing the approval is actually
 * pinned to, so showing it makes "any change re-prompts" legible rather than a
 * claim the UI asks the user to take on faith.
 *
 * Rendered inside the plugin's Permissions tab (`plugin-detail-permissions.tsx`)
 * next to the permission grant/revoke table it conceptually belongs with.
 */

import { useCallback } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { listApprovedBinaries, revokeBinaryApproval } from "@/lib/db/approved-binaries"

export function PluginApprovedBinariesCard({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.approvedBinaries")
  const format = useFormatter()
  const rows = useLiveQuery(() => listApprovedBinaries(pluginId), [pluginId])

  const revoke = useCallback(
    (binaryPath: string) => {
      void revokeBinaryApproval(pluginId, binaryPath)
    },
    [pluginId]
  )

  // `undefined` = the live query hasn't resolved yet. Rendering the empty state
  // during that window would flash "nothing approved" at a user who has
  // approvals, so hold the section back entirely until we know.
  if (rows === undefined) return null

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold">{t("title")}</h3>
      <p className="text-[11px] text-muted-foreground">{t("description")}</p>
      <div className="overflow-hidden rounded-control border">
        {rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={row.binaryPath}
                className="flex items-center justify-between gap-3 p-2.5 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <code className="block truncate font-mono text-[11px]">{row.binaryPath}</code>
                  <span className="block text-[10px] text-muted-foreground">
                    {t("approvedAt", {
                      date: format.dateTime(new Date(row.approvedAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </span>
                  <code className="block font-mono text-[10px] text-muted-foreground">
                    {t("hash", { sha256: row.sha256.slice(0, 16) })}
                  </code>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => revoke(row.binaryPath)}
                  aria-label={t("revokeAria", { path: row.binaryPath })}
                >
                  {t("revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
