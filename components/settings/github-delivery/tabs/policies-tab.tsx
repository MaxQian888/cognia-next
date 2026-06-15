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

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { DEFAULT_GH_POLICY } from "@/lib/github/types"

export function PoliciesTab() {
  const t = useTranslations("settings.githubDelivery.policies")
  const p = DEFAULT_GH_POLICY
  return (
    <div className="space-y-3" data-testid="policies-tab">
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">{t("defaultTitle")}</h3>
        <p className="text-xs text-muted-foreground mb-3">{t("defaultHint")}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("requireGreenCi")}</dt>
          <dd>
            {p.requireGreenCi ? (
              <Badge>{t("required")}</Badge>
            ) : (
              <Badge variant="outline">{t("off")}</Badge>
            )}
          </dd>

          <dt className="text-muted-foreground">{t("requireHumanApproval")}</dt>
          <dd>
            {p.requireHumanApproval ? (
              <Badge>{t("required")}</Badge>
            ) : (
              <Badge variant="outline">{t("off")}</Badge>
            )}
          </dd>

          <dt className="text-muted-foreground">{t("maxDailyMerges")}</dt>
          <dd>
            <Badge variant="secondary">{t("perDay", { count: p.maxDailyMerges })}</Badge>
          </dd>

          <dt className="text-muted-foreground">{t("allowedAuthors")}</dt>
          <dd>
            <Badge variant="outline">{p.allowedAuthors.kind}</Badge>
          </dd>
        </dl>
        <Separator className="my-3" />
        <p className="text-xs font-medium mb-1">{t("protectedBranches")}</p>
        <div className="flex flex-wrap gap-1">
          {p.branchProtection.map((rgx) => (
            <Badge key={rgx} variant="secondary" className="font-mono text-xs">
              {rgx}
            </Badge>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">{t("quietHoursTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("quietHoursDesc")}</p>
      </Card>
    </div>
  )
}
