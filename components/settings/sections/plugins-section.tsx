"use client"

// Settings → Plugins. The full plugin management surface lives at the
// `/plugins` workspace (Library / Discover / Governance / Devtools); this
// Settings entry is intentionally a compact launcher — live status badges
// plus links into the workspace — so it never duplicates the workspace UI.
// Policy / governance controls live under the workspace's Governance section.

import Link from "next/link"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, BoxesIcon, ShieldCheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { listPlugins } from "@/lib/db/plugins"

interface Props {
  /** Optional close handler — called before navigating, in case the host is a Sheet. */
  onClose?: () => void
}

export function PluginsSection({ onClose }: Props) {
  const t = useTranslations("settings.plugins")
  const tOverview = useTranslations("settings.plugins.overview")
  const plugins = useLiveQuery(() => listPlugins(), [])

  const enabled = plugins?.filter((p) => p.enabled).length ?? 0
  const errored = plugins?.filter((p) => p.status === "error").length ?? 0
  const updates =
    plugins?.filter((p) => !!(p.manifest as { updateAvailable?: boolean })?.updateAvailable)
      .length ?? 0

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <BoxesIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Card className="p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2" data-testid="plugins-section-badges">
          <Badge variant="outline" className="text-xs">
            {tOverview("badgeEnabled", { count: enabled })}
          </Badge>
          <Badge variant={updates > 0 ? "secondary" : "outline"} className="text-xs">
            {tOverview("badgeUpdates", { count: updates })}
          </Badge>
          <Badge variant={errored > 0 ? "destructive" : "outline"} className="text-xs">
            {tOverview("badgeError", { count: errored })}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">{tOverview("hint")}</p>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" onClick={() => onClose?.()}>
            <Link href="/plugins?section=library">
              {tOverview("openWorkspace")}
              <ArrowRightIcon className="ml-1.5 size-3.5" />
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline" onClick={() => onClose?.()}>
            <Link href="/plugins?section=governance&gov=permissions">
              <ShieldCheckIcon className="mr-1.5 size-3.5" />
              {tOverview("manageGovernance")}
            </Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}
