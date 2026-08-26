"use client"

/**
 * "What this bot can actually do" card for the adapter detail.
 *
 * The capability projection (`lib/connectors/effective-capabilities.ts`) knows
 * which declared capabilities this instance cannot serve and why — a scope the
 * OAuth grant is missing, an action the upstream OneBot server does not
 * implement, a setting that is off, a scene the platform limits the feature to,
 * or a transport that has no channel for it. Without this card that answer only
 * ever reached the projection's callers: the model quietly stopped being offered
 * a tool and a button quietly disappeared, with nothing telling the operator
 * that re-authorizing would bring it back.
 *
 * Reasons are the point of the card. The available list is a summary; the
 * unavailable list is the actionable half, so it renders first and names the
 * remedy.
 *
 * The words come from `components/connectors/capability-notice.tsx`, which is
 * the single vocabulary for the six causes. This card used to own a private
 * copy under its own namespace — so the same missing Slack scope read as a
 * sentence here and as a vanished button in the Inbox, and only the screen
 * nobody visits while troubleshooting had the sentence.
 *
 * The next step is printed once per CAUSE, not once per capability. A narrow
 * Slack grant suppresses five capabilities for the same missing scope, and
 * five stacked copies of "re-authorize this bot" read as five problems. The
 * reason still repeats — it names a different capability each time — but the
 * remedy is a property of the cause.
 *
 * Capability ids and scope names are shown verbatim, the same way
 * `ConnectedScopesCard` shows raw scopes: they are identifiers the operator
 * matches against the platform's own console, and translating them would make
 * them unsearchable.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useCapabilityUnavailableText } from "@/components/connectors/capability-notice"
import { effectiveCapabilitiesForRow } from "@/lib/connectors/effective-capabilities"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface CapabilityMatrixCardProps {
  row: AdapterInstanceRow
}

export function CapabilityMatrixCard({ row }: CapabilityMatrixCardProps) {
  const t = useTranslations("settings.connections.adapters.capabilityMatrix")
  const describe = useCapabilityUnavailableText()
  const snapshot = effectiveCapabilitiesForRow(row)
  const remedyShown = new Set<string>()

  // A platform with no declared capabilities (a plugin connector that declares
  // none, or a planned-but-disabled platform) has nothing to say here.
  if (snapshot.declared.length === 0) return null

  return (
    <Card data-testid="capability-matrix-card">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {snapshot.suppressed.length > 0 && (
          <div className="space-y-1.5" data-testid="capability-matrix-unavailable">
            <p className="font-medium text-muted-foreground">{t("unavailableLabel")}</p>
            <ul className="space-y-1.5">
              {snapshot.suppressed.map((entry) => {
                const { reason, nextStep } = describe(entry.reason, entry.detail)
                const firstOfCause = !remedyShown.has(entry.reason)
                remedyShown.add(entry.reason)
                return (
                  <li key={entry.capability} className="flex flex-col gap-0.5">
                    <Badge variant="outline" className="w-fit font-mono text-[10px]">
                      {entry.capability}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {reason}
                      {nextStep && firstOfCause ? ` ${nextStep}` : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Conditional for the same reason the unavailable list is: a heading
         * over nothing reads as "failed to load" rather than "none". No rule
         * table can currently suppress a platform's ENTIRE declared set, so
         * this is a guard rather than a state you can reach today — if one
         * ever can, the unavailable list above accounts for all of it. */}
        {snapshot.capabilities.length > 0 && (
          <div className="space-y-1.5" data-testid="capability-matrix-available">
            <p className="font-medium text-muted-foreground">{t("availableLabel")}</p>
            <ul className="flex flex-wrap gap-1.5">
              {snapshot.capabilities.map((capability) => (
                <li key={capability}>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {capability}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">{t("scopeHint")}</p>
      </CardContent>
    </Card>
  )
}
