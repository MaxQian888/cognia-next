"use client"

/**
 * Policies sub-tab. Displays the default GhPolicy that ships with the
 * plugin (DEFAULT_GH_POLICY in lib/github/types.ts) and lets the user
 * adjust the global default. Per-repo overrides live on the repo entry
 * itself (Repos tab).
 *
 * Phase M4 ships a read-only display of the default policy. The save
 * path (writing back into the plugin's settings store) lands in the next
 * iteration.
 */

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { DEFAULT_GH_POLICY } from "@/lib/github/types"

export function PoliciesTab() {
  const p = DEFAULT_GH_POLICY
  return (
    <div className="space-y-3" data-testid="policies-tab">
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">Default policy</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Every action the bot takes is checked against this policy. Per-repo overrides take
          precedence; per-node inspector overrides take final precedence.
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Require green CI</dt>
          <dd>
            {p.requireGreenCi ? <Badge>required</Badge> : <Badge variant="outline">off</Badge>}
          </dd>

          <dt className="text-muted-foreground">Require human approval</dt>
          <dd>
            {p.requireHumanApproval ? (
              <Badge>required</Badge>
            ) : (
              <Badge variant="outline">off</Badge>
            )}
          </dd>

          <dt className="text-muted-foreground">Max daily merges</dt>
          <dd>
            <Badge variant="secondary">{p.maxDailyMerges} / day</Badge>
          </dd>

          <dt className="text-muted-foreground">Allowed authors</dt>
          <dd>
            <Badge variant="outline">{p.allowedAuthors.kind}</Badge>
          </dd>
        </dl>
        <Separator className="my-3" />
        <p className="text-xs font-medium mb-1">Protected branches (regex)</p>
        <div className="flex flex-wrap gap-1">
          {p.branchProtection.map((rgx) => (
            <Badge key={rgx} variant="secondary" className="font-mono text-xs">
              {rgx}
            </Badge>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">Quiet hours</h3>
        <p className="text-xs text-muted-foreground">
          Bot actions are suspended during quiet hours. None configured globally — set per repo if
          you want to mute weekend / nightly activity.
        </p>
      </Card>
    </div>
  )
}
